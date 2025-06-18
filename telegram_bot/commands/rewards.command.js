const rewardsCommand = async (ctx) => {
	try {
		// Показуємо повідомлення про завантаження
		const loadingMessage = await ctx.reply('⏳ Завантажую статистику нарахувань...');

		// Отримуємо загальну статистику системи
		const statsResponse = await fetch(`${process.env.API_URL}/rewards/stats`);

		if (!statsResponse.ok) {
			throw new Error(`Статистика недоступна: ${statsResponse.status}`);
		}

		const statsData = await statsResponse.json();

		// Отримуємо топ гравців за 24 години
		const top24hResponse = await fetch(`${process.env.API_URL}/rewards/top/24h`);
		let top24hData = null;

		if (top24hResponse.ok) {
			top24hData = await top24hResponse.json();
		}

		// Отримуємо топ гравців за весь час
		const topAllTimeResponse = await fetch(`${process.env.API_URL}/rewards/top/all-time?limit=5`);
		let topAllTimeData = null;

		if (topAllTimeResponse.ok) {
			topAllTimeData = await topAllTimeResponse.json();
		}

		// Формуємо повідомлення
		let message = `🏆 *Система нарахувань за активний час*\n\n`;

		// Загальна статистика
		if (statsData.success) {
			const general = statsData.general_stats;
			const today = statsData.today_stats;

			message += `📊 *Загальна статистика:*\n`;
			message += `• Гравців з нагородами: ${general.total_players_with_rewards}\n`;
			message += `• Загалом активних годин: ${general.total_active_hours_all}\n`;
			message += `• Загалом нараховано: ${general.total_coins_awarded_all} GFC\n`;
			message += `• Середньо годин на гравця: ${general.avg_active_hours_per_player}\n\n`;

			message += `📅 *Сьогодні:*\n`;
			message += `• Нагороджено гравців: ${today.players_rewarded_today}\n`;
			message += `• Нараховано коїнів: ${today.total_coins_awarded_today} GFC\n\n`;
		}

		// Топ за 24 години
		if (top24hData && top24hData.success && top24hData.top_players.length > 0) {
			message += `🔥 *Топ активних за останні 24 години:*\n`;
			top24hData.top_players.slice(0, 5).forEach((player, index) => {
				const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
				message += `${emoji} ${player.rank}. \`${player.minecraft_nick}\` - ${player.active_hours_24h}г (${player.coins_earned_24h} GFC)\n`;
			});
			message += `\n`;
		} else {
			message += `🔥 *За останні 24 години:*\n`;
			message += `Поки що немає активних гравців\n\n`;
		}

		// Топ за весь час
		if (topAllTimeData && topAllTimeData.success && topAllTimeData.top_players.length > 0) {
			message += `👑 *Топ активних за весь час:*\n`;
			topAllTimeData.top_players.slice(0, 5).forEach((player, index) => {
				const emoji = index === 0 ? '👑' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
				message += `${emoji} ${player.rank}. \`${player.minecraft_nick}\` - ${player.total_active_hours}г (${player.total_coins_awarded} GFC)\n`;
			});
			message += `\n`;
		}

		// Додаткова інформація
		message += `💡 *Як працює система:*\n`;
		message += `• 1 хвилина активної гри = 1 GFC\n`;
		message += `• AFK час не враховується\n`;
		message += `• Нарахування щодня, грай активніше\n`;
		message += `• Грай активно щоб потрапити в топ!\n\n`;

		message += `⏰ *Наступне нарахування:* ${statsData.next_reward_time || 'завтра, тому грай активніше!'}`;

		// Видаляємо повідомлення про завантаження і відправляємо результат
		await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id);
		await ctx.reply(message, { parse_mode: 'Markdown' });

	} catch (error) {
		console.error('❌ Помилка команди /rewards:', error);

		let errorMessage = '❌ Не вдалося завантажити статистику нарахувань.\n\n';

		if (error.message.includes('404')) {
			errorMessage += 'Система нарахувань ще не налаштована або немає даних.';
		} else if (error.message.includes('500')) {
			errorMessage += 'Помилка сервера. Спробуй пізніше.';
		} else {
			errorMessage += 'Можливо, сервер тимчасово недоступний.';
		}

		errorMessage += '\n\n💡 Спробуй команду /statistic для перегляду своєї особистої статистики.';

		await ctx.reply(errorMessage);
	}
};

/**
 * Команда /rewards24 - топ гравців тільки за 24 години (додаткова команда)
 */
const rewards24Command = async (ctx) => {
	try {
		const response = await fetch(`${process.env.API_URL}/rewards/top/24h`);

		if (!response.ok) {
			throw new Error(`API помилка: ${response.status}`);
		}

		const data = await response.json();

		let message = `🔥 *Топ активних гравців за останні 24 години*\n\n`;

		if (data.success && data.top_players.length > 0) {
			data.top_players.forEach((player, index) => {
				const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' :
					index === 3 ? '🏅' : index === 4 ? '🎖️' : '⭐';
				message += `${emoji} **${player.rank}.** \`${player.minecraft_nick}\`\n`;
				message += `   ⏱️ ${player.active_hours_24h} годин (${player.active_minutes_24h} хв)\n`;
				message += `   💰 Заробив: ${player.coins_earned_24h} GFC\n\n`;
			});

			message += `📊 Всього активних гравців: ${data.total_players}\n`;
		} else {
			message += `😴 За останні 24 години немає активних гравців.\n`;
			message += `Будь першим - зайди на сервер і грай активно!\n`;
		}

		message += `\n⏰ Оновлення щодня о 15:00 за київським часом`;

		await ctx.reply(message, { parse_mode: 'Markdown' });

	} catch (error) {
		console.error('❌ Помилка команди /rewards24:', error);
		await ctx.reply('❌ Не вдалося завантажити топ за 24 години. Спробуй пізніше.');
	}
};

/**
 * Команда /myrewards - персональна статистика нарахувань
 */
const myRewardsCommand = async (ctx) => {
	try {
		const telegramId = ctx.from.id;

		const response = await fetch(`${process.env.API_URL}/rewards/player/${telegramId}`);

		if (response.status === 404) {
			return ctx.reply(
				`❌ У тебе ще немає нарахувань за активний час.\n\n` +
				`💡 **Як отримувати нагороди:**\n` +
				`• Грай активно на сервері\n` +
				`• AFK час не враховується\n` +
				`• 1 хвилина активної гри = 1 GFC\n` +
				`• Нарахування щодня в такий самий час\n\n` +
				`🎮 Почни грати щоб з'явитися в топі!`,
				{ parse_mode: 'Markdown' }
			);
		}

		if (!response.ok) {
			throw new Error(`API помилка: ${response.status}`);
		}

		const data = await response.json();

		if (!data.has_rewards) {
			return ctx.reply(
				`❌ У тебе ще немає даних про нарахування.\n\n` +
				`Можливо, ти ще не грав достатньо часу або система ще не обробила твої дані.`
			);
		}

		const player = data.player_data;

		let message = `🎮 *Твої нарахування за активний час*\n\n`;

		message += `👤 **${player.minecraft_nick}**\n\n`;

		message += `📊 *Загальна статистика:*\n`;
		message += `• Активних годин: ${player.total_active_hours}\n`;
		message += `• Отримано коїнів: ${player.total_coins_awarded} GFC\n`;
		message += `• Остання нагорода: ${player.last_reward_date}\n\n`;

		message += `⏱️ *Поточний стан:*\n`;
		message += `• Загалом активних годин: ${player.current_total_active_hours}\n`;
		message += `• Нових хвилин: ${player.new_active_minutes_since_last_reward}\n`;
		message += `• Потенційних коїнів: ${player.potential_new_coins} GFC\n\n`;

		message += `💰 *Поточний баланс:* ${player.current_game_balance} GFC\n\n`;

		message += `⏰ **Наступна нагорода:** ${player.next_reward_date}`;

		await ctx.reply(message, { parse_mode: 'Markdown' });

	} catch (error) {
		console.error('❌ Помилка команди /myrewards:', error);
		await ctx.reply('❌ Не вдалося завантажити твою статистику нарахувань. Спробуй пізніше.');
	}
};

export {
	rewardsCommand,
	rewards24Command,
	myRewardsCommand
};