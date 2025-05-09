import { Scenes, Markup } from 'telegraf';

const isValidUsername = (str) => /^[a-zA-Z0-9]+$/.test(str);

const registerScene = new Scenes.BaseScene('register');

registerScene.enter((ctx) => {
	ctx.reply('✏️ Введи свій нікнейм (тільки англ. літери та цифри):');
	ctx.session.step = 'awaiting_nick';
});

registerScene.on('text', async (ctx) => {
	const text = ctx.message.text;
	const { step } = ctx.session;

	// Якщо користувач вводить команду, скасовуємо реєстрацію
	if (text.startsWith('/')) {
		ctx.reply('❌ Реєстрація скасована. Ти ввів команду!');
		ctx.session = {};  // Очистити сесію
		ctx.scene.leave();  // Вихід зі сцени
		return;
	}

	// Якщо на етапі введення нікнейму
	if (step === 'awaiting_nick') {
		if (!isValidUsername(text)) {
			return ctx.reply('❌ Некоректний нікнейм. Використовуй тільки англ. літери та цифри.');
		}
		ctx.session.minecraftNick = text;
		ctx.session.step = 'awaiting_password';
		return ctx.reply('🔐 Введи пароль (англ. літери + цифри):');
	}

	// Якщо на етапі введення паролю
	if (step === 'awaiting_password') {
		if (!isValidUsername(text)) {
			return ctx.reply('❌ Некоректний пароль. Тільки англ. літери та цифри.');
		}
		ctx.session.password = text;
		ctx.session.telegramId = ctx.from.id;
		ctx.session.step = null;

		return ctx.reply('🤝 Бажаєш вказати, хто тебе запросив на сервер?', Markup.inlineKeyboard([
			Markup.button.callback('✅ Так', 'ref_yes'),
			Markup.button.callback('❌ Ні', 'ref_no'),
		]));
	}

	// Якщо користувач ще на етапі введення реферала
	if (ctx.session.awaitingRefNick) {
		ctx.session.refTemp = text;
		ctx.session.awaitingRefNick = false;

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
	ctx.reply('✍️ Введи нік гравця, який тебе запросив:');
});

registerScene.action('ref_no', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.referrerNick = null;
	return finishRegistration(ctx);
});

registerScene.action('confirm_ref', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.referrerNick = ctx.session.refTemp;
	return finishRegistration(ctx);
});

registerScene.action('cancel_ref', async (ctx) => {
	await ctx.answerCbQuery();
	ctx.session.refTemp = null;
	ctx.session.referrerNick = null;
	return finishRegistration(ctx);
});

registerScene.on('text', async (ctx) => {
	if (ctx.session.awaitingRefNick) {
		ctx.session.refTemp = ctx.message.text;
		ctx.session.awaitingRefNick = false;

		await ctx.reply(`🔍 Ти ввів: *${ctx.session.refTemp}*\nПідтверджуєш?`, {
			parse_mode: 'Markdown',
			...Markup.inlineKeyboard([
				Markup.button.callback('✅ Так', 'confirm_ref'),
				Markup.button.callback('❌ Ні', 'cancel_ref')
			]),
		});
	}
});

async function finishRegistration(ctx) {
	const { telegramId, minecraftNick, password, referrerNick } = ctx.session;

	try {
		const response = await fetch('http://localhost:4000/players/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ telegramId, minecraftNick, password, referrerNick }),
		});

		const data = await response.json();

		if (response.ok && data.message === 'User registered') {
			let message = `✅ Реєстрація успішна!\n\n👤 Нік: ${minecraftNick}\n🔐 Пароль: ${password}\n\nСервер: mine.forze.space\nВерсія: 1.16 - 1.21.4`

			if (referrerNick && !data.referrer_applied) {
				message += `\n\nГравця з ніком ${referrerNick}, якого ти вказав як того, хто тебе запросив, не знайдено. Ти завжди можеш додати його пізніше командою: /reffer <Нік>`
			}

			message += "\n\nПриємної гри)"

			ctx.reply(message);
		} else if (response.status === 409) {
			ctx.reply('⚠️ Такий нік вже зареєстрований.');
		} else {
			ctx.reply('❌ Помилка при реєстрації. Напиши адміну @forzeoldgg');
		}
	} catch (err) {
		console.error(err);
		ctx.reply('❌ Помилка при з`єднанні з сервером.Напиши адміну @forzeoldgg');
	}

	ctx.scene.leave();
}

export { registerScene };