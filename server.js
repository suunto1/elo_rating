require('dotenv').config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const geoip = require('geoip-lite');
const fs = require('fs');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const cookieParser = require('cookie-parser');

const app = express();
const port = process.env.PORT || 3000;

const multer = require('multer');
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = 'public/avatars/';
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// Конфигурация базы данных
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT
};

const pool = mysql.createPool(dbConfig);

// --- Конфигурация Steam и сессий ---
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const STEAM_REALM = process.env.STEAM_REALM;

if (!STEAM_API_KEY || !STEAM_RETURN_URL || !SESSION_SECRET) {
    console.error('FATAL ERROR: STEAM_API_KEY, STEAM_RETURN_URL or SESSION_SECRET is not defined. Please set it in your .env file.');
    process.exit(1);
}

// Настройка Passport.js
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(
            `SELECT id, steam_id_64, pilot_uuid, username, is_admin FROM users WHERE id = ?`,
            [id]
        );
        const user = rows[0];
        done(null, user);
    } catch (error) {
        console.error("Error deserializing user:", error);
        done(error, null);
    } finally {
        if (connection) connection.release();
    }
});

passport.use(new SteamStrategy({
    returnURL: STEAM_RETURN_URL,
    realm: STEAM_REALM,
    apiKey: STEAM_API_KEY
},
async (identifier, profile, done) => {
    const steamId64 = profile.id;
    let connection;
    try {
        connection = await pool.getConnection();

        // Проверяем, существует ли пользователь с таким Steam ID (Сценарий 1 и 2)
        const [userRows] = await connection.execute(
            `SELECT id, steam_id_64, pilot_uuid, username, is_admin FROM users WHERE steam_id_64 = ?`,
            [steamId64]
        );
        let user = userRows[0];

        if (user) {
            // Сценарий 1: Пользователь найден. Обновляем last_login_at.
            await connection.execute(
                `UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [user.id]
            );
            return done(null, user); // Вход выполнен
        } else {
            // Сценарий 2: Пользователь входит/регистрируется через Steam, но записи в accounts еще нет.
            // Это новый пользователь Steam. Создаем запись с пустым username и pilot_uuid = NULL.
            // username будет заполнен на странице /complete-profile.
            const [insertResult] = await connection.execute(
                `INSERT INTO users (steam_id_64, username, pilot_uuid, last_login_at) VALUES (?, ?, NULL, CURRENT_TIMESTAMP)`,
                [steamId64, ''] // username пока пустой.
            );
            const newUserId = insertResult.insertId;

            // Получаем только что созданного пользователя
            const [newUserRows] = await connection.execute(
                `SELECT id, steam_id_64, pilot_uuid, username, is_admin FROM users WHERE id = ?`,
                [newUserId]
            );
            const newUser = newUserRows[0];

            return done(null, newUser); // Вход выполнен, но нужно запросить имя/фамилию
        }
    } catch (error) {
        console.error("Error during Steam authentication:", error);
        return done(error);
    } finally {
        if (connection) connection.release();
    }
}));


// --- Middleware ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Настройка сессий
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 1 неделя
    }
}));

// Инициализация Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware для добавления информации о пользователе в res.locals для EJS
app.use((req, res, next) => {
    res.locals.user = req.user;
    next();
});

// Middleware для проверки, заполнено ли имя пользователя (для новых Steam-пользователей)
const checkUsernameCompletion = async (req, res, next) => {
    // Если пользователь авторизован, и у него пустой username
    if (req.isAuthenticated() && req.user && req.user.username === '') {
        // И он пытается получить доступ к любой странице, кроме /complete-profile, /auth/steam, /auth/steam/return, /logout
        if (req.path !== '/complete-profile' && req.path !== '/auth/steam' && req.path !== '/auth/steam/return' && req.path !== '/logout') {
            return res.redirect('/complete-profile');
        }
    }
    next();
};
app.use(checkUsernameCompletion);


// --- Маршруты аутентификации Steam ---

// Маршрут для инициирования входа через Steam
app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }));

// Маршрут обратного вызова от Steam
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    async (req, res) => {
        // После успешной аутентификации и обработки в стратегии SteamStrategy
        // req.user содержит данные пользователя из нашей БД.

        // Проверяем, заполнено ли имя пользователя (username)
        if (req.user.username === '') {
            // Если имя не заполнено, перенаправляем на страницу заполнения профиля (Сценарий 2)
            return res.redirect('/complete-profile');
        }

        // Если имя заполнено, и pilot_uuid уже есть (Сценарий 1)
        if (req.user.pilot_uuid) {
            let connection;
            try {
                connection = await pool.getConnection();
                const [pilotNameRow] = await connection.execute(
                    `SELECT Name FROM pilots WHERE UUID = ?`,
                    [req.user.pilot_uuid]
                );
                const pilotName = pilotNameRow[0]?.Name;
                if (pilotName) {
                    return res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
                }
            } catch (error) {
                console.error("Error redirecting to pilot profile after Steam auth:", error);
                // Если не удалось найти имя пилота, продолжаем, перенаправляем на общую страницу профиля
            } finally {
                if (connection) connection.release();
            }
        }

        // Если имя заполнено, но pilot_uuid NULL (пользователь зарегистрирован, но еще не пилот)
        // Перенаправляем на его страницу профиля, где будет отображаться его имя, но без деталей пилота.
        return res.redirect('/profile');
    });

// Маршрут для выхода
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

// --- Маршруты для заполнения имени/фамилии (только для новых пользователей) ---
app.get('/complete-profile', (req, res) => {
    // Если пользователь не авторизован или имя уже заполнено, перенаправляем
    if (!req.isAuthenticated() || req.user.username !== '') {
        return res.redirect('/');
    }
    res.render('complete_profile', { message: null, messageType: null, activeMenu: 'complete-profile' });
});

app.post('/complete-profile', async (req, res) => {
    // Проверяем, что пользователь авторизован и его имя еще не заполнено
    if (!req.isAuthenticated() || req.user.username !== '') {
        return res.status(403).json({ message: "У вас немає прав для виконання цієї дії або профіль вже заповнений." });
    }

    const { first_name, last_name } = req.body;
    if (!first_name || !last_name) {
        return res.status(400).render('complete_profile', { message: "Будь ласка, введіть ім'я та прізвище.", messageType: "danger", activeMenu: 'complete-profile' });
    }

    const username = `${DOMPurify.sanitize(first_name)} ${DOMPurify.sanitize(last_name)}`;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.execute(
            `UPDATE users SET username = ? WHERE id = ?`,
            [username, req.user.id]
        );

        // Обновляем req.user, чтобы Passport знал о новом имени
        req.user.username = username;

        // После заполнения имени, перенаправляем на общую страницу профиля
        res.redirect('/profile');

    } catch (error) {
        console.error("Error completing user profile:", error);
        res.status(500).render('complete_profile', { message: "Помилка при збереженні профілю. Спробуйте ще раз.", messageType: "danger", activeMenu: 'complete-profile' });
    } finally {
        if (connection) connection.release();
    }
});


// --- Существующие маршруты (модифицированные) ---



app.get("/", async (req, res) => {
    console.log("Received request for / (root)");
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(`
            SELECT
                p.Name,
                p.EloRanking,
                p.RaceCount,
                p.UUID,
                p.AverageChange
            FROM pilots p
            ORDER BY p.EloRanking DESC
        `);
        console.log("Pilots data:", rows);
        res.render("pilots", { pilots: rows, activeMenu: 'pilots' });
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send("Error fetching data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/pilots", async (req, res) => {
    console.log("Received request for /pilots");
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(`
            SELECT
                p.Name,
                p.EloRanking,
                p.RaceCount,
                p.UUID,
                p.AverageChange
            FROM pilots p
            ORDER BY p.EloRanking DESC
        `);
        console.log("Pilots data:", rows);
        res.render("pilots", { pilots: rows, activeMenu: 'pilots' });
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send("Error fetching data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/pilot/:name", async (req, res) => {
    const pilotName = req.params.name;
    let connection;
    try {
        connection = await pool.getConnection();
        console.log(`Fetching data for pilot: ${pilotName}`);

        let initialEloRanking = 1500;
        const [eloRaceRows] = await connection.execute(
            `SELECT r.StartDate as Date, rp.EloChange
             FROM raceparticipants rp
             JOIN pilots p ON rp.PilotUUID = p.UUID
             JOIN races r ON rp.RaceUUID = r.UUID
             WHERE p.Name = ?
             ORDER BY r.StartDate`,
            [pilotName]
        );

        let cumulativeElo = initialEloRanking;
        const eloChartData = eloRaceRows.map((race) => {
            const date = new Date(race.Date);
            const utcDate = new Date(date.toISOString());
            cumulativeElo += race.EloChange;
            return {
                Date: utcDate.toISOString(),
                CumulativeElo: cumulativeElo,
            };
        });

        const [pilotStatsRows] = await connection.execute(
            `SELECT
                RaceCount,
                Wins,
                Podiums,
                Top5,
                Top10,
                PodiumPercentage
            FROM pilots
            WHERE Name = ?`,
            [pilotName]
        );

        const pilotStats = pilotStatsRows[0] || {
            RaceCount: 0,
            Wins: 0,
            Podiums: 0,
            Top5: 0,
            Top10: 0,
            PodiumPercentage: 0,
        };

        res.json({
            eloChartData: eloChartData,
            stats: {
                starts: pilotStats.RaceCount,
                wins: pilotStats.Wins,
                podiums: pilotStats.Podiums,
                top5: pilotStats.Top5,
                top10: pilotStats.Top10,
                podiumRate: pilotStats.PodiumPercentage,
            },
        });

    } catch (error) {
        console.error("Error fetching pilot data:", error);
        res.status(500).send("Error fetching pilot data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Маршрут для отображения профиля авторизованного пользователя
app.get("/profile", async (req, res) => {
    // Проверяем, аутентифицирован ли пользователь
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/steam'); // Если нет, перенаправляем на вход через Steam
    }

    // Если пользователь авторизован, но у него еще не заполнено имя, перенаправляем
    if (req.user.username === '') {
        return res.redirect('/complete-profile');
    }

    const userId = req.user.id;
    const pilotUuidFromUser = req.user.pilot_uuid; // UUID пилота, связанный с текущим пользователем

    let connection;
    try {
        connection = await pool.getConnection();

        let pilot = {}; // Инициализируем пустой объект пилота по умолчанию

        if (pilotUuidFromUser) {
            // Если у пользователя есть pilot_uuid, получаем его данные
            const [pilotRows] = await connection.execute(
                `SELECT Name, Shortname, DiscordId, YoutubeChannel, TwitchChannel, Instagram, Twitter, iRacingCustomerId, Country, City, PhotoPath, TeamUUID, IsTeamInterested FROM pilots WHERE UUID = ?`,
                [pilotUuidFromUser]
            );
            pilot = pilotRows[0];

            if (!pilot) {
                // Если pilot_uuid в таблице users есть, но соответствующий пилот удален.
                // В этом случае, очищаем pilot_uuid в таблице users.
                await connection.execute(
                    `UPDATE users SET pilot_uuid = NULL WHERE id = ?`,
                    [userId]
                );
                // Обновляем req.user, чтобы Passport знал об изменении
                req.user.pilot_uuid = null;
                // Теперь pilot будет пустым, и мы отобразим базовый профиль пользователя.
                // Сообщение об ошибке будет отображаться на странице профиля.
                console.warn(`Pilot with UUID ${pilotUuidFromUser} not found for user ${userId}. pilot_uuid set to NULL.`);
            }
        }

        // Если pilot пуст (т.е. pilot_uuid был NULL или очищен),
        // отображаем только базовую информацию о пользователе из таблицы users
        if (!pilot || Object.keys(pilot).length === 0) {
            pilot = {
                Name: req.user.username, // Используем имя из таблицы users
                Shortname: '',
                DiscordId: '',
                YoutubeChannel: '',
                TwitchChannel: '',
                Instagram: '',
                Twitter: '',
                iRacingCustomerId: '',
                Country: '',
                City: '',
                PhotoPath: '/avatars/default_avatar_64.png', // Дефолтная аватарка
                TeamUUID: null,
                IsTeamInterested: false
            };
            // Добавим флаг, чтобы в EJS можно было понять, что это не полный профиль пилота
            pilot.isBasicUser = true;
        }


        const [teamsRows] = await connection.execute(`SELECT UUID, Name FROM teams ORDER BY Name`);
        const teams = teamsRows;

        // Заполняем поля по умолчанию, если они NULL (для случая, если pilot не isBasicUser)
        pilot.PhotoPath = pilot.PhotoPath || '/avatars/default_avatar_64.png';
        pilot.Shortname = pilot.Shortname || '';
        pilot.DiscordId = pilot.DiscordId || '';
        pilot.YoutubeChannel = pilot.YoutubeChannel || '';
        pilot.TwitchChannel = pilot.TwitchChannel || '';
        pilot.Instagram = pilot.Instagram || '';
        pilot.Twitter = pilot.Twitter || '';
        pilot.iRacingCustomerId = pilot.iRacingCustomerId || '';
        pilot.Country = pilot.Country || '';
        pilot.City = pilot.City || '';
        pilot.TeamUUID = pilot.TeamUUID || null;
        pilot.IsTeamInterested = pilot.IsTeamInterested || false;

        res.render("profile", { pilot: pilot, teams: teams, activeMenu: 'profile' });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).send("Помилка завантаження профілю");
    } finally {
        if (connection) connection.release();
    }
});

// Маршрут для публичного просмотра профиля пилота (не требует авторизации)
app.get("/profile/:pilotName", async (req, res) => {
    const pilotName = req.params.pilotName;
    let connection;
    try {
        connection = await pool.getConnection();
        const [pilotRows] = await connection.execute(
            `SELECT Name, Shortname, DiscordId, YoutubeChannel, TwitchChannel, Instagram, Twitter, iRacingCustomerId, Country, City, PhotoPath, TeamUUID, IsTeamInterested FROM pilots WHERE Name = ?`,
            [pilotName]
        );

        let pilot = pilotRows[0];
        if (!pilot) {
            return res.status(404).send("Пилот не найден");
        }

        const [teamsRows] = await connection.execute(`SELECT UUID, Name FROM teams ORDER BY Name`);
        const teams = teamsRows;

        pilot.PhotoPath = pilot.PhotoPath || '/avatars/default_avatar_64.png';
        pilot.Shortname = pilot.Shortname || '';
        pilot.DiscordId = pilot.DiscordId || '';
        pilot.YoutubeChannel = pilot.YoutubeChannel || '';
        pilot.TwitchChannel = pilot.TwitchChannel || '';
        pilot.Instagram = pilot.Instagram || '';
        pilot.Twitter = pilot.Twitter || '';
        pilot.iRacingCustomerId = pilot.iRacingCustomerId || '';
        pilot.Country = pilot.Country || '';
        pilot.City = pilot.City || '';
        pilot.TeamUUID = pilot.TeamUUID || null;
        pilot.IsTeamInterested = pilot.IsTeamInterested || false;

        res.render("profile", { pilot: pilot, teams: teams, activeMenu: 'profile' });
    } catch (error) {
        console.error("Error fetching pilot profile:", error);
        res.status(500).send("Помилка завантаження профілю");
    } finally {
        if (connection) connection.release();
    }
});


// Маршрут для обновления профиля пилота (требует авторизации и привязки к пилоту)
app.post("/profile/:pilotName", async (req, res) => {
    // Проверяем аутентификацию
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: "Ви не авторизовані." });
    }
    // Проверяем, привязан ли пользователь к профилю пилота
    if (!req.user.pilot_uuid) {
        // Если пользователь не привязан к пилоту, он не может редактировать профиль пилота.
        // Возможно, здесь стоит дать ему возможность создать новый профиль пилота или связаться с админом.
        return res.status(403).json({ message: "Ваш обліковий запис не прив'язаний до профілю пілота. Функція редагування недоступна." });
    }

    const pilotNameFromURL = req.params.pilotName;
    const pilotUuidFromToken = req.user.pilot_uuid;

    let connection;
    try {
        connection = await pool.getConnection();

        // Проверяем, что pilotNameFromURL соответствует пилоту, связанному с пользователем
        const [pilotCheck] = await connection.execute(
            `SELECT UUID, Name FROM pilots WHERE Name = ? AND UUID = ?`,
            [pilotNameFromURL, pilotUuidFromToken]
        );

        if (pilotCheck.length === 0) {
            return res.status(403).json({ message: "У вас немає прав для редагування цього профілю." });
        }

        const {
            Shortname,
            DiscordId,
            YoutubeChannel,
            TwitchChannel,
            Instagram,
            Twitter,
            iRacingCustomerId,
            Country,
            City,
            TeamUUID,
        } = req.body;

        let IsTeamInterested = Boolean(req.body.IsTeamInterested);

        let errorMessage = '';

        if (Shortname !== undefined && Shortname !== null && Shortname !== '') {
            if (!/^[A-Za-z]{3}$/.test(Shortname)) {
                errorMessage += 'Поле "3-Letter Shortname" має містити рівно 3 літери (A-Z).\n';
            }
        }

        if (iRacingCustomerId) {
            if (!/^[0-9]+$/.test(iRacingCustomerId)) {
                errorMessage += 'Поле "iRacing Customer ID" повинно містити лише цифри.\n';
            }
        }

        if (errorMessage) {
            return res.status(400).json({ message: errorMessage.trim() });
        }

        const [currentPilotRows] = await connection.execute(
            `SELECT Shortname, TeamUUID FROM pilots WHERE UUID = ?`,
            [pilotUuidFromToken]
        );
        const currentPilotShortname = currentPilotRows[0]?.Shortname;
        const currentPilotTeamUUID = currentPilotRows[0]?.TeamUUID;

        const finalShortname = (Shortname !== undefined && Shortname !== null && Shortname !== '') ? DOMPurify.sanitize(Shortname) : currentPilotShortname;

        let newIsTeamInterested = IsTeamInterested;

        if (TeamUUID && (currentPilotTeamUUID !== TeamUUID || currentPilotTeamUUID === null)) {
            newIsTeamInterested = false;
        } else if (!TeamUUID) {
            newIsTeamInterested = IsTeamInterested;
        }

        const sanitizedDiscordId = DiscordId ? DOMPurify.sanitize(DiscordId) : null;
        const sanitizedYoutubeChannel = YoutubeChannel ? DOMPurify.sanitize(YoutubeChannel) : null;
        const sanitizedTwitchChannel = TwitchChannel ? DOMPurify.sanitize(TwitchChannel) : null;
        const sanitizedInstagram = Instagram ? DOMPurify.sanitize(Instagram) : null;
        const sanitizedTwitter = Twitter ? DOMPurify.sanitize(Twitter) : null;
        const sanitizediRacingCustomerId = iRacingCustomerId ? DOMPurify.sanitize(iRacingCustomerId) : null;
        const sanitizedCountry = Country ? DOMPurify.sanitize(Country) : null;
        const sanitizedCity = City ? DOMPurify.sanitize(City) : null;
        const sanitizedTeamUUID = TeamUUID || null;


        await connection.execute(
            `UPDATE pilots SET
            Shortname = ?,
            DiscordId = ?,
            YoutubeChannel = ?,
            TwitchChannel = ?,
            Instagram = ?,
            Twitter = ?,
            iRacingCustomerId = ?,
            Country = ?,
            City = ?,
            TeamUUID = ?,
            IsTeamInterested = ?
            WHERE UUID = ?`,
            [
                finalShortname,
                sanitizedDiscordId,
                sanitizedYoutubeChannel,
                sanitizedTwitchChannel,
                sanitizedInstagram,
                sanitizedTwitter,
                sanitizediRacingCustomerId,
                sanitizedCountry,
                sanitizedCity,
                sanitizedTeamUUID,
                newIsTeamInterested,
                pilotUuidFromToken
            ]
        );
        res.status(200).json({ message: "Профіль оновлено" });
    } catch (error) {
        console.error("Error updating pilot profile:", error);
        res.status(500).json({ message: "Помилка при оновленні профілю" });
    } finally {
        if (connection) connection.release();
    }
});

// Маршрут для загрузки фото профиля (защищенный)
app.post("/profile/:pilotName/upload-photo", upload.single('photo'), async (req, res) => {
    if (!req.isAuthenticated() || !req.user.pilot_uuid) {
        return res.status(403).json({ message: "У вас немає прав для завантаження фото." });
    }

    console.log("Received file upload:", req.file);
    const pilotNameFromURL = req.params.pilotName;
    const pilotUuidFromToken = req.user.pilot_uuid;

    if (!req.file) {
        return res.status(400).json({ message: "Файл не завантажено" });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [pilotCheck] = await connection.execute(
            `SELECT UUID FROM pilots WHERE Name = ? AND UUID = ?`,
            [pilotNameFromURL, pilotUuidFromToken]
        );

        if (pilotCheck.length === 0) {
            return res.status(403).json({ message: "У вас немає прав для завантаження фото для цього профілю." });
        }

        const photoPath = '/avatars/' + req.file.filename;

        const [rows] = await connection.execute(`SELECT PhotoPath FROM pilots WHERE UUID = ?`, [pilotUuidFromToken]);
        const oldPhotoPath = rows[0]?.PhotoPath;
        if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
            const filePath = path.join(__dirname, 'public', oldPhotoPath);
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting old photo file:', err);
            });
        }

        await connection.execute(
            `UPDATE pilots SET PhotoPath = ? WHERE UUID = ?`,
            [photoPath, pilotUuidFromToken]
        );
        res.status(200).json({ message: "Фото успішно завантажено", photoPath: photoPath });
    } catch (error) {
        console.error("Error uploading photo:", error);
        res.status(500).json({ message: "Помилка при завантаженні фото" });
    } finally {
        if (connection) connection.release();
    }
});

// Маршрут для удаления фото профиля (защищенный)
app.delete("/profile/:pilotName/delete-photo", async (req, res) => {
    if (!req.isAuthenticated() || !req.user.pilot_uuid) {
        return res.status(403).json({ message: "У вас немає прав для видалення фото." });
    }

    const pilotNameFromURL = req.params.pilotName;
    const pilotUuidFromToken = req.user.pilot_uuid;

    let connection;
    try {
        connection = await pool.getConnection();

        const [pilotCheck] = await connection.execute(
            `SELECT UUID FROM pilots WHERE Name = ? AND UUID = ?`,
            [pilotNameFromURL, pilotUuidFromToken]
        );

        if (pilotCheck.length === 0) {
            return res.status(403).json({ message: "У вас немає прав для видалення фото для цього профілю." });
        }

        const [rows] = await connection.execute(`SELECT PhotoPath FROM pilots WHERE UUID = ?`, [pilotUuidFromToken]);
        const oldPhotoPath = rows[0]?.PhotoPath;
        if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
            const filePath = path.join(__dirname, 'public', oldPhotoPath);
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting old photo file:', err);
            });
        }

        const defaultAvatarPath = '/avatars/default_avatar_64.png';

        await connection.execute(
            `UPDATE pilots SET PhotoPath = ? WHERE UUID = ?`,
            [defaultAvatarPath, pilotUuidFromToken]
        );
        res.status(200).json({ message: "Фото видалено", photoPath: defaultAvatarPath });
    } catch (error) {
        console.error("Помилка видалення фото:", error);
        res.status(500).json({ message: "Помилка видалення фото" });
    } finally {
        if (connection) connection.release();
    }
});

app.get("/new-participants", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(`
            SELECT rp.PilotUUID, rp.RaceUUID, r.StartDate
            FROM raceparticipants rp
            JOIN races r ON rp.RaceUUID = r.UUID
            ORDER BY r.StartDate
        `);
        const races = {};
        const cumulativeParticipantsCount = [];
        const newParticipantsCount = [];
        const raceDates = [];
        const allParticipants = new Set();

        rows.forEach((row) => {
            const date = new Date(row.StartDate).toISOString().split('T')[0];
            if (!races[date]) {
                races[date] = new Set();
                raceDates.push(date);
            }
            races[date].add(row.PilotUUID);
        });

        raceDates.sort();

        raceDates.forEach((date) => {
            const participantsInThisRace = races[date];
            const newParticipants = [...participantsInThisRace].filter(
                (pilot) => !allParticipants.has(pilot)
            );
            newParticipantsCount.push(newParticipants.length);
            newParticipants.forEach((pilot) => allParticipants.add(pilot));
            cumulativeParticipantsCount.push(allParticipants.size);
        });

        console.log("Cumulative Participants Count:", cumulativeParticipantsCount);
        console.log("New Participants Count:", newParticipantsCount);
        console.log("Race Dates (sorted):", raceDates);

        res.render("new_participants", {
            cumulativeParticipantsCount: JSON.stringify(cumulativeParticipantsCount),
            newParticipantsCount: JSON.stringify(newParticipantsCount),
            raceDates: JSON.stringify(raceDates),
            activeMenu: 'new-participants'
        });
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send("Error fetching data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/tracks", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log("Connected to database for tracks page.");

        const [tracks] = await connection.execute(`
            SELECT
                tr.TrackName,
                tr.BestQualifyingLapTime,
                tr.BestQualifyingLapPilot,
                tr.BestRaceLapTime,
                tr.BestRaceLapPilot,
                ti.ImagePath
            FROM trackrecords tr
            LEFT JOIN trackimages ti ON tr.TrackName = ti.TrackName
            ORDER BY tr.TrackName
        `);
        console.log("Tracks data fetched successfully.");

        const [topRaceCountPilots] = await connection.execute(
            'SELECT Name, RaceCount FROM pilots ORDER BY RaceCount DESC LIMIT 15'
        );

        const [topWinsPilots] = await connection.execute(
            'SELECT Name, Wins FROM pilots ORDER BY Wins DESC LIMIT 15'
        );

        const [topPodiumsPilots] = await connection.execute(
            'SELECT Name, Podiums FROM pilots ORDER BY Podiums DESC LIMIT 15'
        );

        const [topPolesPilots] = await connection.execute(
            `SELECT BestQualifyingLapPilot AS Name, COUNT(UUID) AS PoleCount
             FROM trackrecords
             WHERE BestQualifyingLapPilot IS NOT NULL AND BestQualifyingLapPilot != ''
             GROUP BY BestQualifyingLapPilot
             ORDER BY PoleCount DESC
             LIMIT 15`
        );

        const [topFastestLapsPilots] = await connection.execute(
            `SELECT BestRaceLapPilot AS Name, COUNT(UUID) AS FastestLapCount
             FROM trackrecords
             WHERE BestRaceLapPilot IS NOT NULL AND BestRaceLapPilot != ''
             GROUP BY BestRaceLapPilot
             ORDER BY FastestLapCount DESC
             LIMIT 15`
        );

        const processedTracks = tracks.map((row) => ({
            TrackName: row.TrackName,
            Image: row.ImagePath,
            BestQualifyingLapTime: row.BestQualifyingLapTime,
            BestQualifyingLapPilot: row.BestQualifyingLapPilot,
            BestRaceLapTime: row.BestRaceLapTime,
            BestRaceLapPilot: row.BestRaceLapPilot,
        }));
        console.log("Processed tracks data for rendering.");

        res.render("tracks", {
            tracks: processedTracks,
            topRaceCountPilots,
            topWinsPilots,
            topPodiumsPilots,
            topPolesPilots,
            topFastestLapsPilots,
            activeMenu: 'tracks'
        });

    } catch (error) {
        console.error("Error fetching data for tracks page:", error);
        res.status(500).send("Error fetching data for tracks page");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/api/events", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(`
            SELECT id, date, description, url
            FROM events
            ORDER BY date
        `);
        res.json({ events: rows });
    } catch (error) {
        console.error("Error fetching events:", error);
        res.status(500).send("Error fetching events");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/calendar", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(`
            SELECT id, date, description, url
            FROM events
            ORDER BY date
        `);
        console.log("Events data:", rows);
        res.render("calendar", { events: rows, activeMenu: 'calendar' });
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send("Error fetching data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.post("/track-view", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const ip = req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;
        const userAgent = req.headers['user-agent'];
        const pageUrl = req.headers.referer || req.headers.referrer || req.originalUrl;

        let processedIp = ip;

        if (ip && ip.includes('.') && ip.split('.').length === 4) {
            const parts = ip.split('.');
            processedIp = parts[0] + '.' + parts[1] + '.' + parts[2] + '.0';
        }
        else if (ip && ip.includes(':')) {
            const parts = ip.split(':');
            if (parts.length > 4) {
                processedIp = parts.slice(0, Math.ceil(parts.length / 2)).join(':') + '::';
            }
        }

        const geo = geoip.lookup(processedIp);
        const countryCode = geo ? geo.country : 'XX';

        console.log(`Tracking view from IP: ${ip} (processed: ${processedIp}), Country: ${countryCode}, User-Agent: ${userAgent}, Page: ${pageUrl}`);

        await connection.execute(
            `INSERT INTO page_views (ip_address, country, user_agent, page_url) VALUES (?, ?, ?, ?)`,
            [processedIp, countryCode, userAgent, pageUrl]
        );

        res.status(200).send("View tracked successfully");
    } catch (error) {
        console.error("Error tracking view:", error);
        res.status(500).send("Error tracking view");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/analytics", async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();

        const [uniqueVisitors] = await connection.execute(`SELECT COUNT(DISTINCT ip_address) as count FROM page_views`);
        const uniqueVisitorsCount = uniqueVisitors[0].count;

        const [viewsByPage] = await connection.execute(`
            SELECT page_url, COUNT(DISTINCT ip_address) as count
            FROM page_views
            GROUP BY page_url
            ORDER BY count DESC
        `);

        const [viewsByCountry] = await connection.execute(`
            SELECT country, COUNT(DISTINCT ip_address) as count
            FROM page_views
            GROUP BY country
            ORDER BY count DESC
        `);

        const [uniqueVisitorsToday] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= CURDATE()
        `);
        const uniqueVisitorsTodayCount = uniqueVisitorsToday[0].count;

        const [uniqueVisitorsThisWeek] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY
        `);
        const uniqueVisitorsThisWeekCount = uniqueVisitorsThisWeek[0].count;

        const [uniqueVisitorsThisMonth] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        `);
        const uniqueVisitorsThisMonthCount = uniqueVisitorsThisMonth[0].count;

        const [uniqueVisitorsLastWeek] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= CURDATE() - INTERVAL (WEEKDAY(CURDATE()) + 7) DAY
              AND visit_time < CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY
        `);
        const uniqueVisitorsLastWeekCount = uniqueVisitorsLastWeek[0].count;

        const [uniqueVisitorsLastMonth] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
              AND visit_time < DATE_FORMAT(CURDATE(), '%Y-%m-01')
        `);
        const uniqueVisitorsLastMonthCount = uniqueVisitorsLastMonth[0].count;

        const [uniqueVisitorsLastYear] = await connection.execute(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM page_views
            WHERE visit_time >= DATE_FORMAT(CURDATE() - INTERVAL 1 YEAR, '%Y-01-01')
              AND visit_time < DATE_FORMAT(CURDATE(), '%Y-01-01')
        `);
        const uniqueVisitorsLastYearCount = uniqueVisitorsLastYear[0].count;

        res.render("analytics", {
            uniqueVisitorsCount,
            viewsByPage,
            viewsByCountry,
            uniqueVisitorsTodayCount,
            uniqueVisitorsThisWeekCount,
            uniqueVisitorsThisMonthCount,
            uniqueVisitorsLastWeekCount,
            uniqueVisitorsLastMonthCount,
            uniqueVisitorsLastYearCount,
            activeMenu: 'analytics'
        });
    } catch (error) {
        console.error("Error fetching analytics data:", error);
        res.status(500).send("Error fetching analytics data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
