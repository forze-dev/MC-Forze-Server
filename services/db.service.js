import mysql from "mysql2/promise"
import "dotenv/config"

const pool = mysql.createPool({
	host: process.env.DB_HOST,
	port: parseInt(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

// Функція для перевірки підключення
async function testDatabaseConnection() {
	try {
		const connection = await pool.getConnection();
		console.log('✅ Успішно підключено до бази даних');
		connection.release();
		return true;
	} catch (error) {
		console.error('❌ Помилка підключення до бази даних:', error);
		return false;
	}
}

// Викликаємо перевірку підключення при імпорті модуля
testDatabaseConnection();

export { pool }