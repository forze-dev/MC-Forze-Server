import { Router } from 'express';
import {
	sendMessageToPlayer,
	changeGamemode,
	teleportPlayer,
	getOnlinePlayers,
	executeCustomCommand,
	getRconStatus
} from '../controllers/server-actions.controller.js';
import { isPlayer, isAdmin } from '../middlewares/checkToken.middleware.js';

const serverActionsRouter = new Router();

// Публічні маршрути (для авторизованих гравців)
serverActionsRouter.get('/players/online', getOnlinePlayers);

// Адміністративні маршрути (тільки для адмінів)
serverActionsRouter.post('/message/send', isAdmin, sendMessageToPlayer);
serverActionsRouter.post('/player/gamemode', isAdmin, changeGamemode);
serverActionsRouter.post('/player/teleport', isAdmin, teleportPlayer);
serverActionsRouter.get('/rcon/status', isAdmin, getRconStatus);
serverActionsRouter.post('/command/execute', isAdmin, executeCustomCommand);

export default serverActionsRouter;