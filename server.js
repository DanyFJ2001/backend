require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { schedulePredictions, scheduleVolcanoChecks, scheduleAlertCleanup, getRecentAlerts } = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Configurar multer para manejar archivos de audio
const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      const uniqueName = `audio-${Date.now()}.m4a`;
      cb(null, uniqueName);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// Initialize scheduled tasks
schedulePredictions();
scheduleVolcanoChecks();
scheduleAlertCleanup();

// Simple in-memory feed store (replace with DB in production)
const feed = [];

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ message: 'CompetenciaSDK server running' });
});

// Helper: Geocode a city/name using OpenWeatherMap Geocoding API
async function geocodeQuery(query) {
  try {
    if (!process.env.OPENWEATHER_KEY) return null;
    const url = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=1&appid=${process.env.OPENWEATHER_KEY}`;
    const r = await axios.get(url);
    if (r.data && r.data.length > 0) return r.data[0];
  } catch (e) {
    console.error('❌ Geocoding error:', e.message || e);
  }
  return null;
}

// ============================================
// WEATHER ENDPOINTS
// ============================================

// Weather proxy endpoint: GET /api/weather?lat=&lon=
app.get('/api/weather', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

    const key = process.env.OPENWEATHER_KEY;
    if (!key) return res.status(500).json({ error: 'OPENWEATHER_KEY not set on server' });

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&appid=${key}&units=metric&lang=es`;

    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    console.error('Error in /api/weather', err?.response?.data || err.message || err);
    res.status(502).json({ error: 'Failed to fetch weather data', details: err?.response?.data || err.message });
  }
});

// ============================================
// CHAT WEATHER ENDPOINT (TEXTO)
// ============================================
app.post('/api/chat-weather', async (req, res) => {
  try {
    let { question, location } = req.body;

    console.log('📩 Chat-weather recibido:', { question, location });

    if (!question) {
      return res.status(400).json({ error: 'Se requiere una pregunta' });
    }

    // If no coordinates provided, try to geocode a city name from the question
    if (!location || !location.lat || !location.lon) {
      console.log('🔎 No hay coordenadas; intentando geocodificar a partir de la pregunta...');
      const geo = await geocodeQuery(question);
      if (geo) {
        location = { lat: geo.lat, lon: geo.lon, name: `${geo.name}, ${geo.country}` };
        console.log('📍 Geocoding encontró:', location);
      } else {
        return res.status(400).json({ error: 'Se requiere ubicación o menciona una ciudad en tu pregunta (ej. "¿Cómo está el clima en Guayaquil?")' });
      }
    }

    // 1. Obtener datos del clima
    const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${location.lat}&lon=${location.lon}&appid=${process.env.OPENWEATHER_KEY}&units=metric&lang=es`;

    console.log('🌤️ Obteniendo clima para:', location);
    const weatherResponse = await axios.get(weatherUrl);
    const weatherData = weatherResponse.data;

    // 2. Preparar contexto
    const weatherContext = {
      ubicacion: weatherData.city.name,
      pais: weatherData.city.country,
      pronostico_5_dias: weatherData.list.slice(0, 8).map(item => ({
        fecha: new Date(item.dt * 1000).toLocaleDateString('es-ES', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric' 
        }),
        hora: new Date(item.dt * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        temperatura: Math.round(item.main.temp),
        sensacion_termica: Math.round(item.main.feels_like),
        descripcion: item.weather[0].description,
        humedad: item.main.humidity,
        viento: item.wind.speed,
        probabilidad_lluvia: item.pop * 100
      }))
    };

    // 3. Construir prompt
    const prompt = `Eres un asistente meteorológico experto. Responde de manera natural y conversacional.

DATOS DEL CLIMA:
${JSON.stringify(weatherContext, null, 2)}

PREGUNTA DEL USUARIO: "${question}"

INSTRUCCIONES:
- Responde en español de forma clara y amigable
- Si preguntan por un día específico, busca en el pronóstico
- Incluye temperatura, condiciones y probabilidad de lluvia
- Si es relevante, da recomendaciones (llevar paraguas, abrigo, etc.)
- Sé conciso pero informativo (máximo 4-5 líneas)
- Si no tienes datos para el día exacto solicitado, ofrece el pronóstico más cercano disponible

Tu respuesta:`;

    // 4. Llamar a OpenAI
    console.log('🤖 Consultando a OpenAI...');
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente meteorológico experto que responde preguntas sobre el clima de manera clara y amigable.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.7
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });

    const aiResponse = openaiResponse.data.choices[0].message.content.trim();

    // 5. Analizar nivel de riesgo
    const nextWeather = weatherData.list[0];
    let riskLevel = 'bajo';
    let probability = 20;

    if (nextWeather.pop > 0.7 || nextWeather.wind.speed > 15) {
      riskLevel = 'alto';
      probability = 80;
    } else if (nextWeather.pop > 0.4 || nextWeather.wind.speed > 10) {
      riskLevel = 'medio';
      probability = 50;
    }

    console.log('✅ Respuesta generada exitosamente');

    // 6. Responder
    res.json({
      response: aiResponse,
      weather_data: {
        risk_level: riskLevel,
        probability: probability,
        temperature: Math.round(nextWeather.main.temp),
        description: nextWeather.weather[0].description,
        location: weatherData.city.name
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error en chat-weather:', error);
    res.status(500).json({ 
      error: 'Error al procesar la consulta climática',
      details: error.message 
    });
  }
});

// ============================================
// AUDIO WEATHER ENDPOINT (VOZ)
// ============================================
app.post('/api/audio-weather', upload.single('audio'), async (req, res) => {
  let audioFilePath = null;
  
  try {
    const { latitude, longitude } = req.body;
    
    console.log('🎤 Audio recibido');
    console.log('📦 File info:', req.file ? { size: req.file.size, path: req.file.path } : 'NO FILE');
    
    if (!req.file) {
      console.error('❌ No file received');
      return res.status(400).json({ error: 'No se recibió archivo de audio' });
    }
    
    if (!latitude || !longitude) {
      console.error('❌ Missing coordinates');
      return res.status(400).json({ error: 'Se requiere ubicación' });
    }

    audioFilePath = req.file.path;
    console.log('📁 Audio guardado en:', audioFilePath);
    console.log('📏 Tamaño del audio:', req.file.size, 'bytes');

    // 1. Transcribir el audio usando Whisper de OpenAI
    console.log('📝 Transcribiendo audio...');
    const audioFormData = new FormData();
    audioFormData.append('file', fs.createReadStream(audioFilePath));
    audioFormData.append('model', 'whisper-1');
    audioFormData.append('language', 'es');

    console.log('🔑 Usando API Key:', process.env.OPENAI_API_KEY ? 'CONFIGURADA' : 'NO CONFIGURADA');

    const transcriptionResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', 
      audioFormData, 
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...audioFormData.getHeaders()
        }
      }
    );

    let userQuestion = transcriptionResponse.data.text;
    console.log('💬 Transcripción:', userQuestion);

    // If coordinates not provided, attempt to geocode from the transcription (e.g., "Clima en Guayaquil")
    let lat = latitude;
    let lon = longitude;
    if (!lat || !lon) {
      console.log('🔎 Coordenadas faltantes; intentando geocodificar a partir de la transcripción...');
      const geo = await geocodeQuery(userQuestion);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
        console.log('📍 Geocoding encontró:', geo.name, geo.country, lat, lon);
      } else {
        console.warn('⚠️ No se encontraron coordenadas por geocoding. Será necesario enviar lat/lon.');
        return res.status(400).json({ error: 'No se recibió ubicación y no se pudo inferir una ciudad de la grabación. Por favor especifica la ciudad en tu mensaje.' });
      }
    }

    // 2. Obtener datos del clima
    const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_KEY}&units=metric&lang=es`;
    const weatherResponse = await axios.get(weatherUrl);
    const weatherData = weatherResponse.data;

    // 3. Preparar contexto para ChatGPT
    const weatherContext = {
      ubicacion: weatherData.city.name,
      pais: weatherData.city.country,
      pronostico_5_dias: weatherData.list.slice(0, 8).map(item => ({
        fecha: new Date(item.dt * 1000).toLocaleDateString('es-ES', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric' 
        }),
        hora: new Date(item.dt * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        temperatura: Math.round(item.main.temp),
        sensacion_termica: Math.round(item.main.feels_like),
        descripcion: item.weather[0].description,
        humedad: item.main.humidity,
        viento: item.wind.speed,
        probabilidad_lluvia: item.pop * 100
      }))
    };

    // 4. Construir prompt para ChatGPT
    const prompt = `Eres un asistente meteorológico experto. El usuario preguntó por VOZ: "${userQuestion}"

DATOS DEL CLIMA:
${JSON.stringify(weatherContext, null, 2)}

INSTRUCCIONES:
- Responde en español de forma natural y conversacional
- Menciona que entendiste su pregunta de voz
- Si preguntan por un día específico, busca en el pronóstico
- Incluye temperatura, condiciones y probabilidad de lluvia
- Da recomendaciones útiles (llevar paraguas, abrigo, etc.)
- Sé conciso pero informativo (máximo 5 líneas)
- Si no tienes datos para el día exacto, ofrece el pronóstico más cercano

Tu respuesta:`;

    // 5. Llamar a OpenAI para generar respuesta
    console.log('🤖 Generando respuesta con OpenAI...');
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente meteorológico amigable que responde consultas de voz.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.7
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });

    const aiResponse = openaiResponse.data.choices[0].message.content.trim();
    console.log('✅ Respuesta generada');

    // 6. Analizar nivel de riesgo
    const nextWeather = weatherData.list[0];
    let riskLevel = 'bajo';
    let probability = 20;

    if (nextWeather.pop > 0.7 || nextWeather.wind.speed > 15) {
      riskLevel = 'alto';
      probability = 80;
    } else if (nextWeather.pop > 0.4 || nextWeather.wind.speed > 10) {
      riskLevel = 'medio';
      probability = 50;
    }

    console.log('✅ Audio procesado exitosamente');

    // 7. Responder
    res.json({
      transcription: userQuestion,
      response: aiResponse,
      weather_data: {
        risk_level: riskLevel,
        probability: probability,
        temperature: Math.round(nextWeather.main.temp),
        description: nextWeather.weather[0].description,
        location: weatherData.city.name
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error en audio-weather:', error?.response?.data || error.message || error);
    res.status(500).json({ 
      error: 'Error al procesar el audio',
      details: error?.response?.data || error.message 
    });
  } finally {
    // Limpiar archivo de audio temporal
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      try {
        fs.unlinkSync(audioFilePath);
        console.log('🗑️ Archivo temporal eliminado');
      } catch (cleanupError) {
        console.error('❌ Error al limpiar archivo temporal:', cleanupError);
      }
    }
  }
});

// ============================================
// FEED ENDPOINTS
// ============================================

// Simple feed endpoints: replace with persistent DB (Supabase/Firestore/MongoDB)
app.get('/api/feed', (req, res) => {
  res.json({ feed });
});

app.post('/api/feed', (req, res) => {
  const { userId, userName, message, lat, lon, type } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const item = {
    id: String(Date.now()),
    userId: userId || 'anonymous',
    userName: userName || 'Anónimo',
    message,
    type: type || 'report',
    location: lat && lon ? { lat, lon } : null,
    createdAt: new Date().toISOString()
  };

  feed.unshift(item);
  res.status(201).json({ item });
});

// ============================================
// VOLCANOES ENDPOINT
// ============================================

// Volcanoes endpoint: fetch from IGEPN or return hardcoded active volcanoes
app.get('/api/volcanoes', async (req, res) => {
  try {
    // Hardcoded active volcanoes in Ecuador (Sierra region)
    // Source: IGEPN (Instituto Geofísico de la Escuela Politécnica Nacional)
    const volcanoes = [
      { 
        id: 'cotopaxi', 
        name: 'Cotopaxi', 
        status: 'activo', 
        lat: -0.680, 
        lon: -78.438, 
        altitude: 5897,
        province: 'Latacunga',
        lastUpdate: new Date().toISOString()
      },
      { 
        id: 'tungurahua', 
        name: 'Tungurahua', 
        status: 'activo', 
        lat: -1.211, 
        lon: -78.442, 
        altitude: 5016,
        province: 'Ambato',
        lastUpdate: new Date().toISOString()
      },
      { 
        id: 'chimborazo', 
        name: 'Chimborazo', 
        status: 'dormido', 
        lat: -1.469, 
        lon: -78.817, 
        altitude: 6263,
        province: 'Riobamba',
        lastUpdate: new Date().toISOString()
      },
      { 
        id: 'pichincha', 
        name: 'Pichincha', 
        status: 'activo', 
        lat: -0.359, 
        lon: -78.506, 
        altitude: 4784,
        province: 'Quito',
        lastUpdate: new Date().toISOString()
      },
      { 
        id: 'antisana', 
        name: 'Antisana', 
        status: 'observacion', 
        lat: -0.481, 
        lon: -78.175, 
        altitude: 5753,
        province: 'Napo',
        lastUpdate: new Date().toISOString()
      }
    ];

    res.json({ volcanoes, source: 'IGEPN Ecuador' });
  } catch (err) {
    console.error('/api/volcanoes error', err);
    res.status(500).json({ error: 'Failed to fetch volcano data' });
  }
});

// ============================================
// AI PREDICT ENDPOINT
// ============================================

// AI predict endpoint: POST /api/predict
// Body: { location: {lat, lon, name}, history: [...], notes: 'optional notes' }
app.post('/api/predict', async (req, res) => {
  try {
    const { location, history, notes } = req.body;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server' });

    // Build a concise prompt for the model. In production, sanitize and limit size.
    const userPrompt = `Eres un asistente climatológico especializado en Ecuador. Recibes estos datos en JSON:\n${JSON.stringify({ location, history, notes }, null, 2)}\n\nDevuelve un JSON con keys: risk_level (bajo/medio/alto), probability (0-100), message (texto corto), recommended_actions (array).`;

    const payload = {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Eres un asistente que genera predicciones de riesgo climático y volcánico basadas en datos.' },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 400,
      temperature: 0.2
    };

    const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const assistant = response.data?.choices?.[0]?.message?.content || '';

    // Try to parse assistant content as JSON; if fails, return raw text too
    let parsed = null;
    try {
      parsed = JSON.parse(assistant);
    } catch (e) {
      parsed = { raw: assistant };
    }

    res.json({ result: parsed });
  } catch (err) {
    console.error('/api/predict error', err?.response?.data || err.message || err);
    res.status(502).json({ error: 'AI prediction failed', details: err?.response?.data || err.message });
  }
});

// ============================================
// ALERTS ENDPOINT
// ============================================

// Alerts endpoint: GET recent alerts generated by scheduler
app.get('/api/alerts', (req, res) => {
  const alerts = getRecentAlerts();
  res.json({ alerts, count: alerts.length });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 CompetenciaSDK server listening on port ${PORT}`);
  console.log(`[INFO] Scheduled tasks initialized`);
  console.log(`[INFO] Available endpoints:`);
  console.log(`  - GET  /api/weather`);
  console.log(`  - POST /api/chat-weather (NUEVO)`);
  console.log(`  - POST /api/audio-weather (NUEVO)`);
  console.log(`  - POST /api/predict`);
  console.log(`  - GET  /api/feed`);
  console.log(`  - POST /api/feed`);
  console.log(`  - GET  /api/volcanoes`);
  console.log(`  - GET  /api/alerts`);
});