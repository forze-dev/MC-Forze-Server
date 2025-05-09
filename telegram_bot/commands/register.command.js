const registerCommand = (ctx) => {
	const chatType = ctx.chat?.type;

	if (chatType === 'private') {
		ctx.scene.enter('register');
	} else {
		ctx.reply('❌ Цю команду можна використовувати лише в особистому чаті зі мною.');
	}
};

export default registerCommand;
