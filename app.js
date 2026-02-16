require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const cors = require('cors');
const methodOverride = require('method-override');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const { v2: cloudinary } = require('cloudinary');

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL
}));


// Middlewares
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(methodOverride('_method'));

// Archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction
    ? { rejectUnauthorized: false }
    : false,
});


// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const allowedCollections = ['designs', 'projects'];

function getTable(name) {
  if (!allowedCollections.includes(name)) {
    throw new Error('Colección inválida');
  }
  return name;
}

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Solo se permiten imágenes'));
    }
    cb(null, true);
  }
});

app.get("/", (req, res) => {
  res.send("API running 🚀");
});

//POST
app.post('/api/:collection', upload.single('image'), async (req, res) => {
  try {
    const table = getTable(req.params.collection);
    const { type, ubication } = req.body;

    if (!req.file || !type) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // subir a cloudinary en carpeta dinámica
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: table,
    });

    fs.unlinkSync(req.file.path);

    await pool.query(
      `INSERT INTO ${table} (img_url, public_id, type, ubication)
       VALUES ($1, $2, $3, $4)`,
      [result.secure_url, result.public_id, type, ubication || null]
    );

    res.status(201).json({
      message: `${table} guardado correctamente`
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

//GET
app.get('/api/:collection', async (req, res) => {
  try {
    const table = getTable(req.params.collection);

    const { rows } = await pool.query(`
      SELECT id, img_url, type, ubication
      FROM ${table}
      ORDER BY created_at DESC
    `);

    res.json(rows);

  } catch (error) {
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

//DELETE
app.delete('/api/:collection/:id', async (req, res) => {
  try {
    const table = getTable(req.params.collection);
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT public_id FROM ${table} WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No existe' });
    }

    const cloudinaryId = rows[0].public_id;

    // borrar de cloudinary
    await cloudinary.uploader.destroy(cloudinaryId);

    // borrar de DB
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);

    res.json({ message: 'Imagen eliminada correctamente' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar imagen' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: "Server error" });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
