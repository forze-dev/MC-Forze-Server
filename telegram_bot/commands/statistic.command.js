const statisticCommand = async (ctx) => {
	try {
		// Отримуємо telegramId користувача
		const telegramId = ctx.from.id;

		// Робимо запит до API для отримання статистики за допомогою fetch
		const response = await fetch(`${process.env.API_URL}/players/telegram/${telegramId}`);

		// Перевіряємо статус відповіді
		if (response.status === 404) {
			return ctx.reply("⚠️ Тебе ще не зареєстровано на сервері. Використай команду /register, щоб зареєструватися.");
		}

		if (!response.ok) {
			throw new Error(`HTTP error! Status: ${response.status}`);
		}

		// Отримуємо дані у форматі JSON
		const stats = await response.json();

		// Перевіряємо чи доступна статистика Plan
		const planDataAvailable = stats.plan_data_available;

		// Форматуємо відповідь для користувача
		let message = `📊 *Твоя статистика, ${stats.minecraft_nick}*\n\n`;

		// Основна інформація
		message += `👤 *Основна інформація:*\n`;
		message += `• Нікнейм: \`${stats.minecraft_nick}\`\n`;
		message += `• Дата реєстрації: ${formatDate(stats.registered_at * 1000)}\n`; // * 1000 бо в базі unix timestamp
		message += `• Ігровий баланс: ${stats.game_balance || 0} GFC\n`;
		message += `• Донатний баланс: ${stats.donate_balance || 0} DFC\n`;
		message += `• Кількість смс за 24 год: ${stats.messages_count || 0}\n`;
		message += `• Знижка: ${stats.discount_percent || 0}%\n`;
		message += `• Кількість рефералів: ${stats.referrals_count || 0}\n\n`;

		// Якщо план статистика доступна, додаємо її
		if (planDataAvailable) {
			// Ігрова активність
			message += `⏱ *Ігрова активність:*\n`;
			message += `• Загальний час гри: ${stats.total_playtime_hours || 0} годин\n`;
			message += `• Кількість сесій: ${stats.total_sessions || 0}\n`;
			message += `• Середня тривалість сесії: ${stats.avg_session_duration_minutes || 0} хвилин\n`;

			// Світи
			if (stats.world_times && stats.world_times.length > 0) {
				message += `• Найбільш відвідуваний світ: ${stats.most_played_world}\n\n`;

				message += `🌍 *Час у світах:*\n`;
				stats.world_times.forEach(world => {
					message += `• ${world.world_name}: ${world.total_time_hours || 0} годин\n`;
				});
				message += `\n`;
			}

			// PvP і PvE статистика
			message += `⚔️ *Бойова статистика:*\n`;
			message += `• Вбито мобів: ${stats.total_mob_kills || 0}\n`;
			message += `• Вбито гравців: ${stats.player_kills || 0}\n`;
			message += `• Кількість смертей: ${stats.total_deaths || 0}\n`;
			message += `• K/D співвідношення: ${stats.kd_ratio || 0}\n\n`;

			// Групи дозволів
			if (stats.permission_groups && stats.permission_groups.length > 0) {
				message += `🔑 *Групи дозволів:*\n`;
				message += stats.permission_groups.map(group => `• ${group}`).join('\n');
				message += `\n\n`;
			}
		} else {
			message += `⚠️ Розширена статистика недоступна. Можливо, ти ще не заходив(ла) на сервер.\n\n`;
		}

		message += `_Заходь на наш сервер: ххххххххххххххххх_`;

		// Відправляємо повідомлення
		ctx.replyWithMarkdown(message);

	} catch (error) {
		console.error('Error fetching player stats:', error);
		ctx.reply("⚠️ Сталася помилка при отриманні статистики. Спробуй пізніше або звернись до адміністрації.");
	}
};

// Функція для форматування дати
function formatDate(timestamp) {
	const date = new Date(timestamp);
	return date.toLocaleDateString('uk-UA', {
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	});
}

export default statisticCommand;
