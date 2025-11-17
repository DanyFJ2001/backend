require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;


// ======================================================
//   CREA LA CARPETA /uploads SI NO EXISTE
// ======================================================
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
console.log("📁 Carpeta de uploads lista:", uploadsDir);


// ======================================================
//   CONFIGURACIÓN DE MULTER (SÚPER ESTABLE)
// ======================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `audio-${Date.now()}.m4a`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});


// ======================================================
//   HEALTH CHECK
// ======================================================
app.get('/', (req, res) => {
  res.json({ message: 'Backend funcionando correctamente 🚀' });
});


// ======================================================
//   ENDPOINT PRINCIPAL: API /audio-weather
// ======================================================
app.post('/api/audio-weather', upload.single('audio'), async (req, res) => {
  let finalPath = null;

  try {
    console.log("🎤 Audio recibido en el servidor");

    if (!req.file) {
      console.error("❌ ERROR: No llegó archivo de audio");
      return res.status(400).json({ error: "No llegó archivo de audio al servidor" });
    }

    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Faltan coordenadas" });
    }

    // Ruta absoluta del audio guardado por multer
    finalPath = path.join(uploadsDir, req.file.filename);

    console.log("📁 Archivo guardado en:", finalPath);
    console.log("📏 Tamaño:", req.file.size);


    // ==================================================
    //   TRANSCRIPCIÓN DE AUDIO (WHISPER)
    // ==================================================
    console.log("📝 Enviando audio a Whisper...");

    const audioForm = new FormData();
    audioForm.append('file', fs.createReadStream(finalPath));
    audioForm.append('model', 'whisper-1');
    audioForm.append('language', 'es');

    const whisperResponse = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      audioForm,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...audioForm.getHeaders(),
        },
      }
    );

    const text = whisperResponse.data.text;
    console.log("💬 Transcripción detectada:", text);


    // ==================================================
    //   OBTENER CLIMA
    // ==================================================
    console.log("🌦️ Consultando el clima...");

    const weatherURL =
      `https://api.openweathermap.org/data/2.5/forecast?lat=${latitude}&lon=${longitude}&appid=${process.env.OPENWEATHER_KEY}&units=metric&lang=es`;

    const weatherRes = await axios.get(weatherURL);
    const weatherData = weatherRes.data;


    // ==================================================
    //   GENERAR RESPUESTA FINAL CON CHATGPT
    // ==================================================
    console.log("🤖 Generando respuesta con OpenAI...");

    const prompt = `
Usuario dijo por voz: "${text}"

Datos del clima (primer bloque del pronóstico):
${JSON.stringify(weatherData.list[0], null, 2)}

Da una respuesta amigable, concisa y en español sobre el clima.
`;

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "Eres un asistente meteorológico experto." },
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        }
      }
    );

    const answer = aiResponse.data.choices[0].message.content;


    // ==================================================
    //   RESPUESTA AL CLIENTE
    // ==================================================
    return res.json({
      transcription: text,
      ai_response: answer,
      location: { latitude, longitude },
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error("❌ ERROR en /api/audio-weather:", err.message);

    return res.status(500).json({
      error: "Error procesando el audio",
      details: err.message,
    });

  } finally {
    // ==================================================
    //   LIMPIEZA DEL ARCHIVO TEMPORAL
    // ==================================================
    if (finalPath && fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
      console.log("🗑️ Archivo temporal eliminado:", finalPath);
    }
  }
});


// ======================================================
//   INICIAR SERVIDOR
// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
  console.log("📡 Endpoint de audio:", "/api/audio-weather");
});
