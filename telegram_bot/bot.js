import { Telegraf, session, Scenes } from 'telegraf';
import 'dotenv/config';

import startCommand from './commands/start.command.js';
import helpCommand from './commands/help.command.js';
import registerCommand from './commands/register.command.js';
import refferCommand from './commands/reffer.command.js';

import { registerScene } from './scenes/register.scene.js';
// Додай інші сцени, наприклад:
// import { feedbackScene } from './scenes/feedback.scene.js';

const tgBot = new Telegraf(process.env.BOT_TOKEN);

// Scenes setup
const stage = new Scenes.Stage([registerScene /*, feedbackScene */]);
tgBot.use(session());
tgBot.use(stage.middleware());

// Команди
tgBot.command('start', startCommand);
tgBot.command('help', helpCommand);
tgBot.command('register', registerCommand);
tgBot.command('reffer', refferCommand);

const startBot = async () => {
	try {
		await tgBot.launch();
		console.log('✅ Бот запущено');
	} catch (err) {
		console.error('❌ Помилка запуску бота:', err);
	}
}

export default startBot;
