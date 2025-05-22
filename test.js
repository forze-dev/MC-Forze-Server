import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Конфігурація для зберігання тимчасових файлів
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const uploadDir = 'uploads/temp';

		// Створюємо директорії, якщо їх немає
		if (!fs.existsSync('uploads')) {
			fs.mkdirSync('uploads', { recursive: true });
		}

		if (!fs.existsSync(uploadDir)) {
			fs.mkdirSync(uploadDir, { recursive: true });
		}

		cb(null, uploadDir);
	},
	filename: (req, file, cb) => {
		// Генеруємо унікальне ім'я файлу з UUID
		const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
		cb(null, uniqueFilename);
	}
});

// Фільтр для перевірки типу файлу
const fileFilter = (req, file, cb) => {
	const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

	if (allowedTypes.includes(file.mimetype)) {
		cb(null, true);
	} else {
		cb(new Error('Невірний формат файлу. Дозволено тільки JPEG, PNG, WebP та GIF!'), false);
	}
};

// Налаштування Multer
const upload = multer({
	storage: storage,
	limits: {
		fileSize: 5 * 1024 * 1024, // 5MB максимальний розмір файлу
		files: 5 // Максимум 5 файлів за раз
	},
	fileFilter: fileFilter
});

// Middleware для обробки завантаження зображень та конвертації у WebP
export const processProductImages = async (req, res, next) => {
	try {
		// Якщо файли не були завантажені, пропускаємо обробку
		if (!req.files || req.files.length === 0) {
			console.log('📁 Файли не завантажені, пропускаємо обробку зображень');
			return next();
		}

		console.log(`📸 Почато обробку ${req.files.length} зображень`);

		const imageUrls = [];
		const targetDir = 'uploads/products';

		// Створюємо директорію для зображень продуктів, якщо вона не існує
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
			console.log(`📁 Створено директорію: ${targetDir}`);
		}

		// Обробляємо кожне завантажене зображення
		for (let i = 0; i < req.files.length; i++) {
			const file = req.files[i];
			console.log(`🔄 Обробка файлу ${i + 1}/${req.files.length}: ${file.originalname}`);

			try {
				// Генеруємо унікальне ім'я для вихідного файлу
				const outputFilename = `${uuidv4()}.webp`;
				const outputPath = path.join(targetDir, outputFilename);

				console.log(`📝 Конвертація в WebP: ${outputFilename}`);

				// Конвертуємо зображення у WebP з якістю 80% та оптимізацією розміру
				await sharp(file.path)
					.resize(800, 800, {
						fit: 'inside',
						withoutEnlargement: true
					}) // Максимальний розмір 800x800, зберігаємо пропорції
					.webp({
						quality: 80,
						effort: 4 // Кращий стиск (0-6, де 6 найкращий)
					})
					.toFile(outputPath);

				console.log(`✅ Зображення збережено: ${outputPath}`);

				// Видаляємо тимчасовий файл
				try {
					fs.unlinkSync(file.path);
					console.log(`🗑️ Видалено тимчасовий файл: ${file.path}`);
				} catch (unlinkError) {
					console.warn(`⚠️ Не вдалося видалити тимчасовий файл: ${file.path}`, unlinkError);
				}

				// Додаємо URL зображення до масиву (без public в шляху)
				const imageUrl = `/uploads/products/${outputFilename}`;
				imageUrls.push(imageUrl);

				console.log(`🔗 Додано URL: ${imageUrl}`);

			} catch (processError) {
				console.error(`❌ Помилка обробки файлу ${file.originalname}:`, processError);

				// Видаляємо тимчасовий файл навіть при помилці
				try {
					fs.unlinkSync(file.path);
				} catch (unlinkError) {
					console.warn(`⚠️ Не вдалося видалити тимчасовий файл після помилки: ${file.path}`);
				}

				// Продовжуємо обробку інших файлів, але логуємо помилку
				continue;
			}
		}

		// Перевіряємо, чи були успішно оброблені файли
		if (imageUrls.length === 0) {
			console.warn('⚠️ Жоден файл не був успішно оброблений');
		} else {
			console.log(`✅ Успішно оброблено ${imageUrls.length} зображень`);
		}

		// Додаємо масив URL зображень до запиту для використання в контролері
		req.processedImages = imageUrls;
		next();

	} catch (error) {
		console.error('❌ Критична помилка обробки зображень:', error);

		// Очищуємо тимчасові файли при критичній помилці
		if (req.files && req.files.length > 0) {
			req.files.forEach(file => {
				try {
					if (fs.existsSync(file.path)) {
						fs.unlinkSync(file.path);
						console.log(`🗑️ Видалено тимчасовий файл після помилки: ${file.path}`);
					}
				} catch (cleanupError) {
					console.warn(`⚠️ Не вдалося видалити файл при очищенні: ${file.path}`);
				}
			});
		}

		return res.status(500).json({
			message: 'Помилка обробки завантажених зображень',
			error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
		});
	}
};

// Middleware для завантаження множинних зображень
export const uploadProductImages = upload.array('images', 5); // максимум 5 зображень

// Додаткові utility функції для роботи з файлами

/**
 * Видаляє зображення з файлової системи
 * @param {string|string[]} imagePaths - Шлях(и) до зображень
 */
export const deleteImages = (imagePaths) => {
	const paths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];

	paths.forEach(imagePath => {
		try {
			// Видаляємо початковий слеш, якщо є
			const cleanPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
			const fullPath = path.join(process.cwd(), cleanPath);

			if (fs.existsSync(fullPath)) {
				fs.unlinkSync(fullPath);
				console.log(`🗑️ Видалено зображення: ${fullPath}`);
			} else {
				console.warn(`⚠️ Файл не знайдено для видалення: ${fullPath}`);
			}
		} catch (error) {
			console.error(`❌ Помилка видалення зображення ${imagePath}:`, error);
		}
	});
};

/**
 * Перевіряє, чи існує зображення
 * @param {string} imagePath - Шлях до зображення
 * @returns {boolean}
 */
export const imageExists = (imagePath) => {
	try {
		const cleanPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
		const fullPath = path.join(process.cwd(), cleanPath);
		return fs.existsSync(fullPath);
	} catch (error) {
		console.error(`❌ Помилка перевірки існування файлу ${imagePath}:`, error);
		return false;
	}
};

/**
 * Отримує інформацію про зображення
 * @param {string} imagePath - Шлях до зображення
 * @returns {Promise<Object|null>}
 */
export const getImageInfo = async (imagePath) => {
	try {
		const cleanPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
		const fullPath = path.join(process.cwd(), cleanPath);

		if (!fs.existsSync(fullPath)) {
			return null;
		}

		const stats = fs.statSync(fullPath);
		const metadata = await sharp(fullPath).metadata();

		return {
			path: imagePath,
			size: stats.size,
			width: metadata.width,
			height: metadata.height,
			format: metadata.format,
			created: stats.birthtime,
			modified: stats.mtime
		};
	} catch (error) {
		console.error(`❌ Помилка отримання інформації про зображення ${imagePath}:`, error);
		return null;
	}
};

/**
 * Очищення старих тимчасових файлів (можна запускати по cron)
 */
export const cleanupTempFiles = () => {
	const tempDir = 'uploads/temp';

	if (!fs.existsSync(tempDir)) {
		return;
	}

	try {
		const files = fs.readdirSync(tempDir);
		const now = Date.now();
		const maxAge = 24 * 60 * 60 * 1000; // 24 години

		files.forEach(file => {
			const filePath = path.join(tempDir, file);
			const stats = fs.statSync(filePath);

			if (now - stats.mtime.getTime() > maxAge) {
				fs.unlinkSync(filePath);
				console.log(`🗑️ Видалено старий тимчасовий файл: ${filePath}`);
			}
		});
	} catch (error) {
		console.error('❌ Помилка очищення тимчасових файлів:', error);
	}
};

// Middleware для обробки помилок завантаження
export const handleUploadError = (error, req, res, next) => {
	if (error instanceof multer.MulterError) {
		switch (error.code) {
			case 'LIMIT_FILE_SIZE':
				return res.status(400).json({
					message: 'Файл занадто великий. Максимальний розмір: 5MB'
				});
			case 'LIMIT_FILE_COUNT':
				return res.status(400).json({
					message: 'Занадто багато файлів. Максимум: 5 файлів'
				});
			case 'LIMIT_UNEXPECTED_FILE':
				return res.status(400).json({
					message: 'Неочікуване поле файлу'
				});
			default:
				return res.status(400).json({
					message: 'Помилка завантаження файлу',
					error: error.message
				});
		}
	}

	if (error.message.includes('Невірний формат файлу')) {
		return res.status(400).json({
			message: error.message
		});
	}

	next(error);
};