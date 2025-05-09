import { Router } from "express";
import { register, addReferrer, getPlayerStatsByTelegramId, getPlayerStatsByNick } from "../controllers/players.controller.js";

const playersRouter = new Router()

playersRouter.post("/register", register)
playersRouter.post("/add-reffer", addReferrer)
playersRouter.get('/telegram/:telegramId', getPlayerStatsByTelegramId);
playersRouter.get('/minecraft/:minecraftNick', getPlayerStatsByNick);

export default playersRouter