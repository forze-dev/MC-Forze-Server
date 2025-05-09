import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import startBot from './telegram_bot/bot.js';
import playersRouter from './router/players.router.js';

// Створюємо Express додаток
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Маршрути
app.use('/players', playersRouter);

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