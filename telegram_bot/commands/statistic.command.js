const statisticCommand = async (ctx) => {
	try {
		// Отримуємо telegramId користувача
		const telegramId = ctx.from.id;

		// Робимо запит до API для отримання основної статистики
		const response = await fetch(`${process.env.API_URL}/players/telegram/${telegramId}`);

		// Перевіряємо статус відповіді
		if (response.status === 404) {
			return ctx.reply("⚠️ Тебе ще не зареєстровано на сервері. Використай команду /register, щоб зареєструватися.");
		}

		if (!response.ok) {
			throw new Error(`HTTP error! Status: ${response.status}`);
		}

		// Отримуємо основну статистику
		const stats = await response.json();

		// Отримуємо статистику нарахувань за активний час
		let playtimeRewards = null;
		try {
			const playtimeResponse = await fetch(`${process.env.API_URL}/playtime-rewards/player/${telegramId}`);
			if (playtimeResponse.ok) {
				const playtimeData = await playtimeResponse.json();
				playtimeRewards = playtimeData.has_rewards ? playtimeData.player_data : null;
			}
		} catch (playtimeError) {
			console.log('Дані про нарахування за активний час недоступні:', playtimeError.message);
		}

		// Перевіряємо чи доступна статистика Plan
		const planDataAvailable = stats.plan_data_available;

		// Форматуємо відповідь для користувача
		let message = `📊 *Твоя статистика, ${stats.minecraft_nick}*\n\n`;

		// Основна інформація
		message += `👤 *Основна інформація:*\n`;
		message += `• Нікнейм: \`${stats.minecraft_nick}\`\n`;
		message += `• Дата реєстрації: ${formatDate(stats.registered_at * 1000)}\n`;
		message += `• Ігровий баланс: ${stats.game_balance || 0} GFC\n`;
		message += `• Донатний баланс: ${stats.donate_balance || 0} DFC\n`;
		message += `• Кількість смс за 24 год: ${stats.messages_count || 0}\n`;
		message += `• Знижка: ${stats.discount_percent || 0}%\n`;
		message += `• Кількість рефералів: ${stats.referrals_count || 0}\n\n`;

		// НОВА СЕКЦІЯ: Нарахування за активний час
		if (playtimeRewards) {
			message += `🎮 *Нарахування за активний час:*\n`;
			message += `• Загальний активний час: ${playtimeRewards.total_active_hours} годин\n`;
			message += `• Загалом отримано коїнів: ${playtimeRewards.total_coins_awarded} GFC\n`;
			message += `• Поточний активний час: ${playtimeRewards.current_total_active_hours} годин\n`;
			message += `• Нових хвилин з останньої нагороди: ${playtimeRewards.new_active_minutes_since_last_reward}\n`;
			message += `• Потенційних нових коїнів: ${playtimeRewards.potential_new_coins} GFC\n`;
			message += `• Остання нагорода: ${playtimeRewards.last_reward_date}\n`;
			message += `• Наступна нагорода: ${playtimeRewards.next_reward_date}\n\n`;
		} else {
			message += `🎮 *Нарахування за активний час:*\n`;
			message += `• Ще не отримував нагороди за активний час\n`;
			message += `• Грай активно щоб отримувати 1 GFC за хвилину!\n`;
			message += `• Нарахування щодня, грай активніше\n\n`;
		}

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
				stats.world_times.slice(0, 3).forEach(world => { // Показуємо тільки топ-3 світи
					message += `• ${world.world_name}: ${world.total_time_hours || 0} годин\n`;
				});
				if (stats.world_times.length > 3) {
					message += `• ... та ще ${stats.world_times.length - 3} світів\n`;
				}
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
			message += `⚠️ Розширена статистика недоступна.\n`;
			message += `Можливо, ти ще не грав на сервері або дані ще обробляються.\n\n`;
		}

		// Додаємо інформацію про систему нарахувань
		message += `💡 *Інформація:*\n`;
		message += `• 1 хвилина активної гри = 1 GFC\n`;
		message += `• AFK час не враховується\n`;
		message += `• Нарахування щодня, грай активніше\n`;
		message += `• Використай /rewards для перегляду топ активних гравців`;

		await ctx.reply(message, { parse_mode: 'Markdown' });

	} catch (error) {
		console.error('❌ Помилка отримання статистики:', error);
		await ctx.reply('❌ Виникла помилка при отриманні твоєї статистики. Спробуй пізніше.');
	}
};

// Функція для форматування дати
function formatDate(timestamp) {
	return new Date(timestamp).toLocaleDateString('uk-UA', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

export default statisticCommand;