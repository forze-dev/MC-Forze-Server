const apiUrl = process.env.API_URL || 'http://localhost:4000';

const onlineCommand = async (ctx) => {
	try {
		console.log(`🔄 Користувач ${ctx.from.id} запустив команду /online`);

		// Відправляємо повідомлення про завантаження
		const loadingMessage = await ctx.reply('🔍 Перевіряю онлайн гравців на сервері...');

		// Робимо запит до API для отримання списку онлайн гравців
		const response = await fetch(`${apiUrl}/rcon-server/players/online`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
			}
		});

		// Перевіряємо тип контенту відповіді
		const contentType = response.headers.get('content-type');
		let data;

		if (contentType && contentType.includes('application/json')) {
			data = await response.json();
			console.log(`📨 Отримано відповідь від API: ${response.status} ${JSON.stringify(data)}`);
		} else {
			// Якщо відповідь не JSON
			const textResponse = await response.text();
			console.error(`❌ Сервер повернув не JSON відповідь: ${textResponse}`);

			// Редагуємо повідомлення про завантаження
			await ctx.telegram.editMessageText(
				ctx.chat.id,
				loadingMessage.message_id,
				null,
				'❌ Помилка з\'єднання з сервером. Спробуй пізніше.'
			);
			return;
		}

		// Якщо запит успішний
		if (response.ok && data) {
			let message = '🎮 <b>Онлайн на сервері:</b>\n\n';

			if (data.count === 0 || !data.players || data.players.length === 0) {
				message += '😴 На сервері зараз немає гравців :(';
			} else {
				message += `👥 <b>Всього гравців: ${data.count}</b>\n\n`;

				// Додаємо список гравців
				data.players.forEach((player) => {
					message += `- <code>${player}</code>\n`;
				});

				// Додаємо інформацію про сервер
				message += `\n😎 <b>Заходь до нас :)</b>\nхххххххх.ххххххххх`;
			}

			// Редагуємо повідомлення про завантаження з результатом
			await ctx.telegram.editMessageText(
				ctx.chat.id,
				loadingMessage.message_id,
				null,
				message,
				{ parse_mode: 'HTML' }
			);

			console.log(`✅ Команда /online успішно виконана для користувача ${ctx.from.id}`);
		} else {
			// Обробка помилок від API
			console.log(`⚠️ Помилка отримання онлайн гравців: ${response.status} ${JSON.stringify(data)}`);

			let errorMessage = '❌ Помилка отримання списку гравців';

			switch (response.status) {
				case 401:
					errorMessage = '❌ Помилка авторизації. Спробуй пізніше';
					break;
				case 500:
					errorMessage = '❌ Помилка сервера. Можливо, сервер Minecraft недоступний';
					break;
				case 503:
					errorMessage = '❌ Сервіс тимчасово недоступний. Спробуй пізніше';
					break;
				default:
					if (data && data.message) {
						errorMessage = `❌ ${data.message}`;
					}
			}

			// Редагуємо повідомлення про завантаження з помилкою
			await ctx.telegram.editMessageText(
				ctx.chat.id,
				loadingMessage.message_id,
				null,
				errorMessage
			);
		}

	} catch (error) {
		console.error(`❌ Помилка в команді /online: ${error}`);

		try {
			// Спробуємо відредагувати повідомлення, якщо воно існує
			if (ctx.callbackQuery?.message?.message_id) {
				await ctx.telegram.editMessageText(
					ctx.chat.id,
					ctx.callbackQuery.message.message_id,
					null,
					'❌ Виникла помилка при отриманні списку гравців. Спробуй пізніше.'
				);
			} else {
				await ctx.reply('❌ Виникла помилка при отриманні списку гравців. Спробуй пізніше.');
			}
		} catch (editError) {
			console.error(`❌ Помилка редагування повідомлення: ${editError}`);
			// Якщо не вдалося відредагувати, відправляємо нове повідомлення
			try {
				await ctx.reply('❌ Виникла помилка при отриманні списку гравців. Спробуй пізніше.');
			} catch (replyError) {
				console.error(`❌ Помилка відправки повідомлення: ${replyError}`);
			}
		}
	}
};

export default onlineCommand;