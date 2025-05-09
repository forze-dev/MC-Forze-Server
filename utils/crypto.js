import crypto from 'crypto';

// Генерація солі (16 байт = 32 hex символи)
function generateSalt(length = 16) {
	return crypto.randomBytes(length / 2).toString('hex');
}

// Функція хешування пароля для AuthMeReloaded (SHA256)
function hashPassword(password) {
	const salt = generateSalt();
	// Подвійне хешування
	const firstHash = crypto.createHash('sha256').update(password).digest('hex');
	const secondHash = crypto.createHash('sha256').update(firstHash + salt).digest('hex');

	return `$SHA$${salt}$${secondHash}`;
}

// Порівняння паролів
function comparePassword(password, hashedPassword) {
	const [prefix, salt, hash] = hashedPassword.split('$').filter(Boolean);
	if (prefix !== 'SHA') return false;

	// Перше хешування пароля
	const firstHash = crypto.createHash('sha256').update(password).digest('hex');
	// Друге хешування з сіллю
	const secondHash = crypto.createHash('sha256').update(firstHash + salt).digest('hex');

	return secondHash === hash;
}

export { hashPassword, comparePassword };
