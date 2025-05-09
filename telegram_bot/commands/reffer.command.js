const refferCommand = async (ctx) => {
	try {
		// Перевіряємо, чи є аргументи в команді
		const args = ctx.message.text.split(' ').slice(1);

		if (args.length === 0) {
			return ctx.reply('⚠️ Вкажи нік гравця, який тебе запросив на сервер.\nПриклад: /reffer NickName');
		}

		const referrerNick = args[0];
		const telegramId = ctx.from.id.toString();

		// URL до твого API
		const apiUrl = 'http://localhost:4000/players/add-reffer'; // Заміни на свою URL

		// Робимо запит до API використовуючи fetch
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				telegramId,
				referrerNick
			})
		});

		// Перевіряємо тип контенту відповіді
		const contentType = response.headers.get('content-type');
		let data;

		if (contentType && contentType.includes('application/json')) {
			data = await response.json();
		} else {
			// Якщо відповідь не JSON, просто отримуємо текст для логування
			const textResponse = await response.text();
			console.error('Сервер повернув не JSON відповідь:', textResponse);
			return ctx.reply('❌ Помилка з`єднання з сервером. Спробуй пізніше.');
		}

		// Якщо успішно додано реферала
		if (response.ok) {
			return ctx.reply(`✅ Гравця ${referrerNick} успішно вказано як того, хто запросив тебе на сервер!`);
		} else {
			// Обробка помилок від API
			switch (response.status) {
				case 400:
					if (data.message === 'Missing telegramId or referrerNick') {
						return ctx.reply('⚠️ Помилка: не вказано нік гравця');
					} else if (data.message === 'Cannot set yourself as a referrer') {
						return ctx.reply('⚠️ Ти не можеш вказати себе');
					}
					break;
				case 404:
					if (data.message === 'User not found') {
						return ctx.reply('⚠️ Ти ще не зареєстрований на сервері. Спочатку зареєструйся командою /register');
					} else if (data.message === 'Referrer not found') {
						return ctx.reply(`⚠️ Гравця з ніком ${args[0]} не знайдено на сервері`);
					}
					break;
				case 409:
					if (data.message === 'User already has a referrer') {
						return ctx.reply('⚠️ Ти вже вказав гравця, який тебе запросив, і не можеш його змінити');
					}
					break;
				default:
					return ctx.reply(`❌ Помилка сервера: ${response.status}. Спробуй пізніше.`);
			}
		}

	} catch (error) {
		console.error('Error in reffer command:', error);
		return ctx.reply('❌ Виникла помилка. Спробуй пізніше.');
	}
};

export default refferCommand;