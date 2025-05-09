import { Telegraf, session, Scenes } from 'telegraf';
import 'dotenv/config';

import startCommand from './commands/start.command.js';
import helpCommand from './commands/help.command.js';
import registerCommand from './commands/register.command.js';
import refferCommand from './commands/reffer.command.js';
import statisticCommand from './commands/statistic.command.js';

import { registerScene } from './scenes/register.scene.js';
import { handleMessage } from './handlers/messageCounter.handler.js';

// Перевірка наявності токена бота
if (!process.env.BOT_TOKEN) {
	console.error('❌ Помилка: BOT_TOKEN не вказано в змінних оточення');
	process.exit(1);
}

const tgBot = new Telegraf(process.env.BOT_TOKEN);

// Scenes setup
const stage = new Scenes.Stage([registerScene /*, feedbackScene */]);
tgBot.use(session());
tgBot.use(stage.middleware());

// Глобальний обробник помилок
tgBot.catch((err, ctx) => {
	console.error(`❌ Помилка в Telegraf: ${err}`);
	ctx.reply('❌ Сталася помилка. Будь ласка, спробуйте пізніше або зверніться до адміністратора.');
});

// Логування вхідних повідомлень
tgBot.use((ctx, next) => {
	const user = ctx.from ? `${ctx.from.id} (${ctx.from.username || 'no username'})` : 'невідомий користувач';
	const messageType = ctx.updateType || 'невідомий тип';

	console.log(`📩 Отримано ${messageType} від користувача ${user}`);
	return next();
});

// Додаємо обробник повідомлень для підрахунку
tgBot.use(handleMessage);

// Команди
tgBot.command('start', startCommand);
tgBot.command('help', helpCommand);
tgBot.command('register', registerCommand);
tgBot.command('reffer', refferCommand);
tgBot.command('statistic', statisticCommand);

const startBot = async () => {
	try {
		// Запускаємо бота
		await tgBot.launch();
		console.log('✅ Бот запущено');
		console.log(`🔗 API URL: ${process.env.API_URL || 'http://localhost:4000'}`);
	} catch (err) {
		console.error('❌ Помилка запуску бота:', err);
	}
}

// Обробка завершення роботи
process.once('SIGINT', () => {
	console.log('🛑 Отримано сигнал SIGINT, зупиняю бота...');
	tgBot.stop('SIGINT');
});

process.once('SIGTERM', () => {
	console.log('🛑 Отримано сигнал SIGTERM, зупиняю бота...');
	tgBot.stop('SIGTERM');
});

export default startBot;