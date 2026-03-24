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

// ========== VALIDACIÓN DE VARIABLES CRÍTICAS ==========
console.log('=== INICIANDO SERVIDOR ===');
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');

// Verificar DATABASE_URL (CRÍTICA)
if (!process.env.DATABASE_URL) {
  console.error('❌ ERROR CRÍTICO: DATABASE_URL no está configurada');
  console.error('❌ El servidor no puede iniciar sin conexión a base de datos');
  console.error('❌ Por favor, configura DATABASE_URL en las variables de entorno de Render');
  process.exit(1); // Detiene el servidor si no hay DB
}

console.log('✅ DATABASE_URL configurada correctamente');

// Verificar Cloudinary (opcional, solo mostrar warning)
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('⚠️  ADVERTENCIA: Cloudinary no está configurado correctamente');
  console.warn('⚠️  Las funciones de subida de imágenes no funcionarán');
}
// =====================================================

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || '*'
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

// ========== CONFIGURACIÓN DE BASE DE DATOS ==========
const isProduction = process.env.NODE_ENV === "production";

let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
      require: true
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    host: process.env.DB_HOST,
  });
  console.log('✅ Pool de base de datos configurado');
} catch (error) {
  console.error('❌ Error configurando pool de base de datos:', error.message);
  process.exit(1);
}

// Verificar conexión a la base de datos (async, no bloquea el inicio)
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a la base de datos:', err.message);
    console.error('❌ Verifica que la URL de Supabase sea correcta y que el proyecto esté activo');
  } else {
    console.log('✅ Conexión a base de datos establecida correctamente');
    release();
  }
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en pool de base de datos:', err);
});
// ====================================================

// ========== CONFIGURACIÓN DE CLOUDINARY ==========
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Verificar configuración de Cloudinary (opcional)
if (process.env.CLOUDINARY_CLOUD_NAME) {
  console.log('✅ Cloudinary configurado');
} else {
  console.log('⚠️  Cloudinary no configurado - las subidas de imágenes fallarán');
}
// ==================================================

const allowedCollections = ['designs', 'projects'];

function getTable(name) {
  if (!allowedCollections.includes(name)) {
    throw new Error('Colección inválida');
  }
  return name;
}

// Configuración de multer con manejo de errores
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Solo se permiten imágenes'));
      return;
    }
    cb(null, true);
  }
});

// ========== ENDPOINTS ==========
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "API running 🚀",
    timestamp: new Date().toISOString(),
    dbConfigured: !!pool
  });
});

// Endpoint de health check para Render
app.get("/health", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: "healthy", 
      database: "connected",
      time: result.rows[0].now 
    });
  } catch (error) {
    res.status(500).json({ 
      status: "unhealthy", 
      error: error.message 
    });
  }
});

// POST
app.post('/api/:collection', upload.single('image'), async (req, res) => {
  try {
    const table = getTable(req.params.collection);
    const { type, ubication } = req.body;

    if (!req.file || !type) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // Verificar Cloudinary antes de subir
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      // Limpiar archivo temporal
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(500).json({ error: 'Cloudinary no está configurado' });
    }

    // Subir a Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: table,
    });

    // Limpiar archivo temporal
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }

    await pool.query(
      `INSERT INTO ${table} (img_url, public_id, type, ubication)
       VALUES ($1, $2, $3, $4)`,
      [result.secure_url, result.public_id, type, ubication || null]
    );

    res.status(201).json({
      message: `${table} guardado correctamente`
    });

  } catch (error) {
    console.error('Error en POST:', error);
    // Limpiar archivo temporal si existe
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // Ignorar error al limpiar
      }
    }
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// GET
const VALID_TABLES = ['designs', 'projects'];

app.get('/api/:collection', async (req, res) => {
  try {
    const collection = req.params.collection;
    
    if (!VALID_TABLES.includes(collection)) {
      return res.status(400).json({ error: 'Colección no válida' });
    }
    
    const { rows } = await pool.query(`
      SELECT id, img_url, type, ubication
      FROM ${collection}
      ORDER BY created_at DESC
    `);
    
    res.json(rows);
    
  } catch (error) {
    console.error('Error en GET:', error);
    res.status(500).json({ error: 'Error al obtener datos' });
  }
});

// DELETE
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

    // Borrar de Cloudinary (si está configurado)
    if (process.env.CLOUDINARY_CLOUD_NAME && cloudinaryId) {
      await cloudinary.uploader.destroy(cloudinaryId);
    }

    // Borrar de DB
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);

    res.json({ message: 'Imagen eliminada correctamente' });

  } catch (error) {
    console.error('Error en DELETE:', error);
    res.status(500).json({ error: 'Error al eliminar imagen' });
  }
});

// ========== MANEJO DE ERRORES ==========
app.use((err, req, res, next) => {
  console.error('Error en middleware global:', err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message === 'Colección inválida') {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: "Server error" });
});

// ========== INICIO DEL SERVIDOR ==========
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Health check: /health`);
  console.log(`🌐 API: /api/designs o /api/projects`);
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido, cerrando servidor...');
  server.close(() => {
    console.log('Servidor cerrado');
    process.exit(0);
  });
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  server.close(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});
