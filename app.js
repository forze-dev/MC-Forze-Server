import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import startBot from './telegram_bot/bot.js';
import playersRouter from './router/players.router.js';

// Перевірка змінних оточення
if (!process.env.PORT) {
	console.warn('⚠️ Змінна PORT не вказана в змінних оточення. Використовується значення за замовчуванням 4000');
}

// Створюємо Express додаток
const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логування запитів
app.use((req, res, next) => {
	console.log(`📨 ${req.method} ${req.url}`);
	next();
});

// Маршрути
app.use('/players', playersRouter);

// Базовий маршрут для перевірки роботи сервера
app.get('/', (req, res) => {
	res.send('Forze Server Core API працює! 👍');
});

// Обробка 404 помилок
app.use((req, res) => {
	console.log(`⚠️ Маршрут не знайдено: ${req.method} ${req.url}`);
	res.status(404).json({ message: 'Шлях не знайдено' });
});

// Обробка помилок
app.use((err, req, res, next) => {
	console.error(`❌ Помилка обробки запиту: ${err.stack}`);
	res.status(500).json({ message: 'Внутрішня помилка сервера' });
});

// Створюємо HTTP сервер
const server = http.createServer(app);

// Запускаємо сервер
server.listen(PORT, () => {
	console.log(`✅ Сервер запущено на порту ${PORT}`);
	console.log(`🔗 API URL: ${process.env.API_URL || `http://localhost:${PORT}`}`);
});

// Запускаємо Telegram бота
startBot();

// Обробка помилок
process.on('uncaughtException', (error) => {
	console.error('❌ Неопрацьоване виключення:', error);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('❌ Неопрацьоване відхилення promise:', promise, 'причина:', reason);
});

// Обробка завершення роботи
process.on('SIGINT', () => {
	console.log('🛑 Отримано сигнал SIGINT, завершую роботу...');
	server.close(() => {
		console.log('✓ Сервер зупинено');
		process.exit(0);
	});
});

process.on('SIGTERM', () => {
	console.log('🛑 Отримано сигнал SIGTERM, завершую роботу...');
	server.close(() => {
		console.log('✓ Сервер зупинено');
		process.exit(0);
	});
});