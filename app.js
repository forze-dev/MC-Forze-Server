import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import startBot from './telegram_bot/bot.js';
import playersRouter from './router/players.router.js';
import productsRouter from './router/products.router.js';
import adminAuthRouter from './router/admin.router.js';

// Отримання __dirname в ES модулях
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Створюємо Express додаток
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Статичні файли
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Маршрути
app.use('/players', playersRouter);
app.use('/products', productsRouter);
app.use('/products', adminAuthRouter);

// Створюємо HTTP сервер
const server = http.createServer(app);

// Запускаємо сервер
server.listen(process.env.PORT, () => {
	console.log(`✅ Server running!`);
});

// Запускаємо Telegram бота
startBot();

// Обробка помилок
process.on('uncaughtException', (error) => {
	console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});