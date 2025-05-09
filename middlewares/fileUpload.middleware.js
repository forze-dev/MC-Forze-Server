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
			fs.mkdirSync('uploads');
		}

		if (!fs.existsSync(uploadDir)) {
			fs.mkdirSync(uploadDir);
		}

		cb(null, uploadDir);
	},
	filename: (req, file, cb) => {
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
	},
	fileFilter: fileFilter
});

// Middleware для обробки завантаження зображень та конвертації у WebP
export const processProductImages = async (req, res, next) => {
	try {
		// Якщо файли не були завантажені, пропускаємо обробку
		if (!req.files || req.files.length === 0) {
			return next();
		}

		const imageUrls = [];
		const targetDir = 'uploads/products';

		// Створюємо директорію для зображень продуктів, якщо вона не існує
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		// Обробляємо кожне завантажене зображення
		for (const file of req.files) {
			const outputFilename = `${uuidv4()}.webp`;
			const outputPath = path.join(targetDir, outputFilename);

			// Конвертуємо зображення у WebP з якістю 80%
			await sharp(file.path)
				.webp({ quality: 80 })
				.toFile(outputPath);

			// Видаляємо тимчасовий файл
			fs.unlinkSync(file.path);

			// Додаємо URL зображення до масиву
			const imageUrl = `/uploads/products/${outputFilename}`;
			imageUrls.push(imageUrl);
		}

		// Додаємо масив URL зображень до запиту для використання в контролері
		req.processedImages = imageUrls;
		next();
	} catch (error) {
		console.error('Error processing images:', error);
		return res.status(500).json({ message: 'Error processing uploaded images' });
	}
};

// Middleware для завантаження множинних зображень
export const uploadProductImages = upload.array('images', 5); // максимум 5 зображень
