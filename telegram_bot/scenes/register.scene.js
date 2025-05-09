import { Scenes, Markup } from 'telegraf';

const isValidUsername = (str) => /^[a-zA-Z0-9]+$/.test(str);
const apiUrl = process.env.API_URL || 'http://localhost:4000';

const registerScene = new Scenes.BaseScene('register');

registerScene.enter((ctx) => {
	console.log(`🔄 Користувач ${ctx.from.id} розпочав реєстрацію`);
	ctx.reply('✏️ Введи свій нікнейм (тільки англ. літери та цифри):');
	ctx.session.step = 'awaiting_nick';
});

// Єдиний обробник для всіх текстових повідомлень
registerScene.on('text', async (ctx) => {
	const text = ctx.message.text;
	const { step } = ctx.session;

	console.log(`📨 Отримано повідомлення від ${ctx.from.id} [Етап: ${step || 'невідомий'}]: ${text}`);

	// Якщо користувач вводить команду, скасовуємо реєстрацію
	if (text.startsWith('/')) {
		console.log(`❌ Користувач ${ctx.from.id} скасував реєстрацію, ввівши команду`);
		ctx.reply('❌ Реєстрація скасована. Ти ввів команду!');
		ctx.session = {};  // Очистити сесію
		ctx.scene.leave();  // Вихід зі сцени
		return;
	}

	// Якщо на етапі введення нікнейму
	if (step === 'awaiting_nick') {
		if (!isValidUsername(text)) {
			console.log(`⚠️ Користувач ${ctx.from.id} ввів некоректний нікнейм: ${text}`);
			return ctx.reply('❌ Некоректний нікнейм. Використовуй тільки англ. літери та цифри.');
		}
		ctx.session.minecraftNick = text;
		ctx.session.step = 'awaiting_password';
		console.log(`✅ Користувач ${ctx.from.id} встановив нікнейм: ${text}`);
		return ctx.reply('🔐 Введи пароль (англ. літери + цифри):');
	}

	// Якщо на етапі введення паролю
	if (step === 'awaiting_password') {
		if (!isValidUsername(text)) {
			console.log(`⚠️ Користувач ${ctx.from.id} ввів некоректний пароль`);
			return ctx.reply('❌ Некоректний пароль. Тільки англ. літери та цифри.');
		}
		ctx.session.password = text;
		ctx.session.telegramId = ctx.from.id;
		ctx.session.step = 'awaiting_referrer_decision';
		console.log(`✅ Користувач ${ctx.from.id} встановив пароль`);

		return ctx.reply('🤝 Бажаєш вказати, хто тебе запросив на сервер?', Markup.inlineKeyboard([
			Markup.button.callback('✅ Так', 'ref_yes'),
			Markup.button.callback('❌ Ні', 'ref_no'),
		]));
	}

	// Якщо користувач на етапі введення реферала
	if (ctx.session.awaitingRefNick) {
		ctx.session.refTemp = text;
		ctx.session.awaitingRefNick = false;
		console.log(`✅ Користувач ${ctx.from.id} вказав реферала: ${text}`);

		await ctx.reply(`🔍 Ти ввів: *${ctx.session.refTemp}*\nПідтверджуєш?`, {
			parse_mode: 'Markdown',
			...Markup.inlineKeyboard([
				Markup.button.callback('✅ Так', 'confirm_ref'),
				Markup.button.callback('❌ Ні', 'cancel_ref')
			]),
		});
	}
});

registerScene.action('ref_yes', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.awaitingRefNick = true;
	console.log(`🔄 Користувач ${ctx.from.id} вирішив додати реферала`);
	ctx.reply('✍️ Введи нік гравця, який тебе запросив:');
});

registerScene.action('ref_no', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.referrerNick = null;
	console.log(`🔄 Користувач ${ctx.from.id} вирішив не додавати реферала`);
	return finishRegistration(ctx);
});

registerScene.action('confirm_ref', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.referrerNick = ctx.session.refTemp;
	console.log(`✅ Користувач ${ctx.from.id} підтвердив реферала: ${ctx.session.refTemp}`);
	return finishRegistration(ctx);
});

registerScene.action('cancel_ref', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.refTemp = null;
	ctx.session.referrerNick = null;
	console.log(`❌ Користувач ${ctx.from.id} скасував вибір реферала`);
	return finishRegistration(ctx);
});

async function finishRegistration(ctx) {
	const { telegramId, minecraftNick, password, referrerNick } = ctx.session;
	console.log(`🔄 Завершення реєстрації для ${telegramId} (${minecraftNick}), реферал: ${referrerNick || 'немає'}`);

	try {
		const response = await fetch(`${apiUrl}/players/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ telegramId, minecraftNick, password, referrerNick }),
		});

		const data = await response.json();
		console.log(`📨 Отримано відповідь від API: ${response.status} ${JSON.stringify(data)}`);

		if (response.ok && data.message === 'User registered') {
			let message = `✅ Реєстрація успішна!\n\n👤 Нік: ${minecraftNick}\n🔐 Пароль: ${password}\n\nСервер: ххххххххххххххххх\nВерсія: 1.16 - 1.21.4`

			if (referrerNick && !data.referrer_applied) {
				message += `\n\nГравця з ніком ${referrerNick}, якого ти вказав як того, хто тебе запросив, не знайдено. Ти завжди можеш додати його пізніше командою: /reffer <Нік>`
			}

			message += "\n\nПриємної гри)"

			ctx.reply(message);
			console.log(`✅ Користувач ${telegramId} успішно зареєстрований як ${minecraftNick}`);
		} else if (response.status === 409) {
			ctx.reply('⚠️ Такий нік вже зареєстрований.');
			console.log(`⚠️ Помилка: нік ${minecraftNick} вже існує`);
		} else {
			ctx.reply('❌ Помилка при реєстрації. Напиши адміну @forzeoldgg');
			console.log(`❌ Помилка реєстрації: ${JSON.stringify(data)}`);
		}
	} catch (err) {
		console.error(`❌ Помилка при з'єднанні з API: ${err}`);
		ctx.reply('❌ Помилка при з`єднанні з сервером. Напиши адміну @forzeoldgg');
	}

	ctx.scene.leave();
	console.log(`🔄 Користувач ${telegramId} вийшов зі сцени реєстрації`);
}

export { registerScene };