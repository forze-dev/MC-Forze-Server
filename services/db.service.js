import mysql from "mysql2/promise"
import "dotenv/config"

const pool = mysql.createPool({
	host: process.env.DB_HOST,
	port: parseInt(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	// Додаткові важливі налаштування
	waitForConnections: true,       // Чекати на з'єднання, якщо немає вільних
	connectionLimit: 10,            // Максимальна кількість з'єднань у пулі
	queueLimit: 0,                  // Необмежена черга (0 = без обмежень)
	enableKeepAlive: true,          // Утримувати з'єднання активними
	keepAliveInitialDelay: 10000,   // Затримка між keepalive запитами
	// Обробка перезапуску
	connectTimeout: 30000,          // Більш тривалий таймаут підключення (30 секунд)
});

// Функція для перевірки підключення
async function testDatabaseConnection() {
	let connection;
	try {
		connection = await pool.getConnection();
		console.log('✅ Успішно підключено до бази даних');
		return true;
	} catch (error) {
		console.error('❌ Помилка підключення до бази даних:', error);
		return false;
	} finally {
		// Безпечніший спосіб звільнення з'єднання
		if (connection) {
			try {
				connection.release();
			} catch (releaseError) {
				console.warn('⚠️ Попередження при звільненні з\'єднання:', releaseError);
			}
		}
	}
}

// Додаємо обробник помилок для пулу
pool.on('error', (err) => {
	console.error('❌ Помилка пулу з\'єднань MySQL:', err);
	// Спроба відновити з'єднання в разі серйозних помилок
	if (err.code === 'PROTOCOL_CONNECTION_LOST' ||
		err.code === 'ECONNRESET' ||
		err.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR') {
		console.log('⚠️ Спроба переналаштування з\'єднання...');
		testDatabaseConnection();
	}
});

// Викликаємо перевірку підключення при імпорті модуля
testDatabaseConnection();

export { pool }; 