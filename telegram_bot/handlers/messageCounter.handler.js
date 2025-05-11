import { incrementUserMessages, isUserRegistered } from '../../services/redis.service.js';

// ID чату, в якому відстежуються повідомлення
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

/**
 * Обробляє повідомлення для нарахування балів
 * @param {object} ctx Контекст Telegraf
 */
const handleMessage = async (ctx, next) => {
	try {
		// Швидкі перевірки без звернення до бази даних
		if (!ctx.from || ctx.from.is_bot) {
			return next();
		}

		if (!ctx.message || !ctx.message.text) {
			return next();
		}

		if (!ctx.chat || ctx.chat.id.toString() !== TARGET_CHAT_ID) {
			return next();
		}

		const telegramId = ctx.from.id.toString();
		const messageText = ctx.message.text;

		// Перевіряємо мінімальну довжину повідомлення (3+ символи)
		if (messageText.length < 3) {
			return next();
		}

		// Перевіряємо, чи це не команда
		if (messageText.startsWith('/')) {
			return next();
		}

		// Перевіряємо, чи зареєстрований користувач (з Redis кешу)
		const isRegistered = await isUserRegistered(telegramId);
		if (!isRegistered) {
			return next();
		}

		// Інкрементуємо лічильник повідомлень
		const result = await incrementUserMessages(telegramId);

		// Логуємо результат (для дебагу)
		switch (result) {
			case "COOLDOWN":
				console.log(`📨 Кулдаун для користувача ${telegramId}`);
				break;
			case "LIMIT_REACHED":
				console.log(`📨 Користувач ${telegramId} досяг денного ліміту`);
				break;
			case "ERROR":
				console.error(`❌ Помилка обліку повідомлення для користувача ${telegramId}`);
				break;
			default:
				console.log(`✅ Повідомлення зараховано для ${telegramId}: ${result}/200`);
		}
	} catch (error) {
		console.error('❌ Помилка обробки повідомлення:', error);
	}

	return next();
};

export { handleMessage };