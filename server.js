require('dotenv').config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const geoip = require('geoip-lite'); // Не используется в этом фрагменте, но оставлено
const fs = require('fs');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const cookieParser = require('cookie-parser'); // Используется express-session, но оставлено для совместимости

const app = express();
const port = process.env.PORT || 3000;

// Multer для загрузки файлов
const multer = require('multer');
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = 'public/avatars/';
        // Создаем директорию, если она не существует
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Генерируем уникальное имя файла
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// DOMPurify для санитизации HTML
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

// Проверка наличия обязательных переменных окружения
if (!STEAM_API_KEY || !STEAM_RETURN_URL || !SESSION_SECRET || !STEAM_REALM) {
    console.error('FATAL ERROR: STEAM_API_KEY, STEAM_RETURN_URL, SESSION_SECRET, or STEAM_REALM is not defined. Please set it in your .env file.');
    process.exit(1);
}

// Настройка Passport.js
passport.serializeUser((user, done) => {
    // В сессию сохраняем ID пользователя из нашей таблицы `users` (primary key)
    // `user.id` здесь - это `id` из вашей таблицы `users`
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    let connection;
    try {
        connection = await pool.getConnection();
        // Ищем пользователя по ID из таблицы `users`
        // Добавляем `first_name` и `last_name` для использования в EJS
        const [rows] = await connection.execute(
            `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin FROM users WHERE id = ?`,
            [id]
        );
        const user = rows[0];
        if (user) {
            done(null, user); // Пользователь найден и доступен в req.user
        } else {
            console.warn(`User with ID ${id} not found during deserialization.`);
            done(null, false); // Пользователь не найден, сессия недействительна
        }
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
    const steamId64 = profile.id; // SteamID64
    const steamDisplayName = profile.displayName; // Имя пользователя из Steam
    let connection;
    try {
        connection = await pool.getConnection();

        // 1. Проверяем, существует ли пользователь с таким Steam ID в нашей таблице `users`
        const [userRows] = await connection.execute(
            `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin FROM users WHERE steam_id_64 = ?`,
            [steamId64]
        );
        let user = userRows[0];
        let pilotUuidToLink = null; // Для хранения UUID пилота, если найден

        // 2. Ищем существующего пилота по SteamId в таблице `pilots`
        // Это необходимо для Сценария 1 (если user.pilot_uuid === NULL) и Сценария 2 (для нового пользователя)
        const [pilotRows] = await connection.execute(
            `SELECT UUID FROM pilots WHERE steam_id_64 = ?`, // Использование steam_id_64 из схемы pilots
            [steamId64]
        );
        if (pilotRows.length > 0) {
            pilotUuidToLink = pilotRows[0].UUID;
            console.log(`Found existing pilot UUID ${pilotUuidToLink} for Steam ID ${steamId64}`);
        }

        if (user) {
            // Сценарий 1: Пользователь найден в `users`
            console.log("Existing user found in `users` table:", user.id);

            // Если user.pilot_uuid NULL, но мы нашли соответствующего пилота, связываем
            if (!user.pilot_uuid && pilotUuidToLink) {
                console.log(`Linking existing pilot ${pilotUuidToLink} to user ${user.id}`);
                await connection.execute(
                    `UPDATE users SET pilot_uuid = ? WHERE id = ?`,
                    [pilotUuidToLink, user.id]
                );
                user.pilot_uuid = pilotUuidToLink; // Обновляем объект пользователя
            }

            // Если username пустой или совпадает со steamId64 (первичная запись),
            // обновляем его на Steam Display Name.
            // first_name и last_name останутся пустыми, пока пользователь их не заполнит.
            if (user.username === '' || user.username === steamId64) {
                await connection.execute(
                    `UPDATE users SET username = ? WHERE id = ?`,
                    [steamDisplayName, user.id]
                );
                user.username = steamDisplayName; // Обновляем объект пользователя
            }
            
            // Обновляем время последнего входа
            await connection.execute(
                `UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [user.id]
            );

            // Возвращаем полный объект пользователя для сериализации
            return done(null, {
                id: user.id,
                steam_id_64: user.steam_id_64,
                pilot_uuid: user.pilot_uuid,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                is_admin: user.is_admin
            });
        } else {
            // Сценарий 2: Пользователь входит/регистрируется через Steam, но записи в `users` еще нет.
            console.log("New Steam user. Creating new entry in `users` table.");

            const [insertResult] = await connection.execute(
                `INSERT INTO users (steam_id_64, username, first_name, last_name, pilot_uuid, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [steamId64, steamDisplayName, '', '', pilotUuidToLink] // steamDisplayName как начальный username. first_name/last_name пока пустые
            );
            const newUserId = insertResult.insertId;

            // Получаем только что созданного пользователя, чтобы передать полный объект в Passport
            const [newUserRows] = await connection.execute(
                `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin FROM users WHERE id = ?`,
                [newUserId]
            );
            const newUser = newUserRows[0];

            return done(null, newUser); // Вход выполнен, возможно, нужно запросить имя/фамилию
        }
    } catch (error) {
        console.error("Error during Steam authentication strategy:", error);
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
    resave: false, // Не сохранять сессию, если она не была изменена
    saveUninitialized: false, // Не сохранять новую, неинициализированную сессию
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true в продакшене (HTTPS)
        maxAge: 1000 * 60 * 60 * 24 * 7 // 1 неделя
    }
}));

// Инициализация Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware для добавления информации о пользователе в res.locals для EJS
app.use((req, res, next) => {
    // Если пользователь авторизован, формируем user.username для отображения
    if (req.isAuthenticated() && req.user) {
        if (req.user.first_name && req.user.last_name) {
            res.locals.user = {
                ...req.user,
                username: `${req.user.first_name} ${req.user.last_name}`
            };
        } else {
            // Если first_name/last_name не заполнены, используем username из базы (Steam Display Name)
            res.locals.user = req.user;
        }
    } else {
        res.locals.user = null;
    }
    next();
});

// Middleware для проверки, заполнено ли имя пользователя (для новых Steam-пользователей)
const checkUsernameCompletion = async (req, res, next) => {
    // Если пользователь авторизован, но у него не заполнены first_name ИЛИ last_name
    if (req.isAuthenticated() && req.user && (!req.user.first_name || !req.user.last_name)) {
        // И он пытается получить доступ к любой странице, кроме /complete-profile, /auth/steam, /auth/steam/return, /logout
        if (req.path !== '/complete-profile' && req.path !== '/auth/steam' && req.path !== '/auth/steam/return' && req.path !== '/logout') {
            console.log(`Redirecting user ${req.user.id} to /complete-profile as first_name or last_name is missing.`);
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

        // Проверяем, заполнено ли имя пользователя (first_name и last_name)
        if (!req.user.first_name || !req.user.last_name) {
            console.log(`User ${req.user.id} needs to complete profile. Redirecting to /complete-profile.`);
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
                    console.log(`User ${req.user.id} (Pilot ${pilotName}) redirected to /profile/${encodeURIComponent(pilotName)}`);
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
        console.log(`User ${req.user.id} is authenticated but not linked to a pilot. Redirecting to /profile.`);
        return res.redirect('/profile'); // Перенаправляем на общую страницу профиля
    });

// Маршрут для выхода
app.get('/logout', (req, res, next) => {
    // req.logout() требует колбэк в Express 5+
    req.logout((err) => {
        if (err) { return next(err); }
        // Очищаем сессию после выхода
        req.session.destroy((err) => {
            if (err) {
                console.error('Error destroying session:', err);
                return next(err);
            }
            res.clearCookie('connect.sid'); // Очищаем куку сессии
            res.redirect('/');
        });
    });
});

// --- Маршруты для заполнения имени/фамилии (только для новых пользователей) ---
app.get('/complete-profile', (req, res) => {
    // Если пользователь не авторизован или его first_name и last_name уже заполнены
    if (!req.isAuthenticated() || (req.user.first_name && req.user.last_name)) {
        console.log(`User ${req.user.id} is already completed or not authenticated. Redirecting to /.`);
        return res.redirect('/');
    }
    // Если first_name или last_name пусты, передаем их как пустые строки в шаблон
    res.render('complete_profile', { 
        message: null, 
        messageType: null, 
        activeMenu: 'complete-profile',
        first_name: req.user.first_name || '',
        last_name: req.user.last_name || ''
    });
});

app.post('/complete-profile', async (req, res) => {
    // Проверяем, что пользователь авторизован и его first_name/last_name еще не заполнены
    if (!req.isAuthenticated() || (req.user.first_name && req.user.last_name)) {
        return res.status(403).json({ message: "У вас немає прав для виконання цієї дії або профіль вже заповнений." });
    }

    const { first_name, last_name } = req.body;
    // Санитизация входных данных
    const sanitizedFirstName = DOMPurify.sanitize(first_name).trim();
    const sanitizedLastName = DOMPurify.sanitize(last_name).trim();

    if (!sanitizedFirstName || !sanitizedLastName) {
        return res.status(400).render('complete_profile', { 
            message: "Будь ласка, введіть ім'я та прізвище.", 
            messageType: "danger", 
            activeMenu: 'complete-profile',
            first_name: sanitizedFirstName, // Возвращаем введенные значения
            last_name: sanitizedLastName
        });
    }

    // Совмещаем имя и фамилию для `username` (если он используется для отображения)
    const combinedUsername = `${sanitizedFirstName} ${sanitizedLastName}`;
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Обновляем username, first_name, last_name
        await connection.execute(
            `UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE id = ?`,
            [combinedUsername, sanitizedFirstName, sanitizedLastName, req.user.id]
        );

        // Обновляем req.user, чтобы Passport знал о новом имени
        req.user.username = combinedUsername;
        req.user.first_name = sanitizedFirstName;
        req.user.last_name = sanitizedLastName;

        // После заполнения имени, проверяем, есть ли пилот с таким SteamId, чтобы связать (Сценарий 3)
        let pilotUuidToLink = null;
        const [pilotRows] = await connection.execute(
            `SELECT UUID FROM pilots WHERE steam_id_64 = ?`, // Ищем пилота по SteamId
            [req.user.steam_id_64]
        );
        if (pilotRows.length > 0) {
            pilotUuidToLink = pilotRows[0].UUID;
            // Если пилот найден и еще не связан, обновляем pilot_uuid в users
            if (!req.user.pilot_uuid && pilotUuidToLink) {
                 await connection.execute(
                    `UPDATE users SET pilot_uuid = ? WHERE id = ?`,
                    [pilotUuidToLink, req.user.id]
                );
                req.user.pilot_uuid = pilotUuidToLink; // Обновляем req.user
                console.log(`User ${req.user.id} linked to pilot ${pilotUuidToLink} after profile completion.`);
            }
        }

        // Перенаправляем на страницу профиля пользователя
        if (req.user.pilot_uuid) {
            // Если теперь есть pilot_uuid, пробуем перенаправить на страницу пилота
            const [pilotNameRow] = await connection.execute(
                `SELECT Name FROM pilots WHERE UUID = ?`,
                [req.user.pilot_uuid]
            );
            const pilotName = pilotNameRow[0]?.Name;
            if (pilotName) {
                console.log(`User ${req.user.id} redirected to pilot profile: /profile/${encodeURIComponent(pilotName)}`);
                return res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
            }
        }
        console.log(`User ${req.user.id} profile completed. Redirecting to /profile.`);
        res.redirect('/profile'); // Если pilot_uuid нет или имя пилота не найдено
    } catch (error) {
        console.error("Error completing user profile:", error);
        res.status(500).render('complete_profile', { 
            message: "Помилка при збереженні профілю. Спробуйте ще раз.", 
            messageType: "danger", 
            activeMenu: 'complete-profile',
            first_name: sanitizedFirstName,
            last_name: sanitizedLastName
        });
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
        console.log("Pilots data:", rows.length > 0 ? `Fetched ${rows.length} pilots.` : 'No pilots found.');
        res.render("pilots", { pilots: rows, activeMenu: 'pilots' });
    } catch (error) {
        console.error("Error fetching data for / (root):", error);
        res.status(500).send("Error fetching data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Закомментированный маршрут /pilots удален, так как / теперь обслуживает рейтинг.

app.get("/pilot/:name", async (req, res) => {
    const pilotName = req.params.name;
    let connection;
    try {
        connection = await pool.getConnection();
        console.log(`Fetching data for pilot: ${pilotName}`);

        // Ищем пилота по имени, чтобы получить его UUID, т.к. в дальнейшем запросы идут по UUID
        const [pilotLookupRows] = await connection.execute(
            `SELECT UUID FROM pilots WHERE Name = ?`,
            [pilotName]
        );

        if (pilotLookupRows.length === 0) {
            console.warn(`Pilot with name ${pilotName} not found.`);
            return res.status(404).send("Pilot not found");
        }
        const pilotUUID = pilotLookupRows[0].UUID;


        let initialEloRanking = 1500;
        const [eloRaceRows] = await connection.execute(
            `SELECT r.StartDate as Date, rp.EloChange
             FROM raceparticipants rp
             JOIN pilots p ON rp.PilotUUID = p.UUID
             JOIN races r ON rp.RaceUUID = r.UUID
             WHERE p.UUID = ? -- Изменено на поиск по UUID
             ORDER BY r.StartDate`,
            [pilotUUID]
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
            WHERE UUID = ?`, // Изменено на поиск по UUID
            [pilotUUID]
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
        console.log("User not authenticated, redirecting to Steam auth.");
        return res.redirect('/auth/steam'); // Если нет, перенаправляем на вход через Steam
    }

    // Если пользователь авторизован, но у него еще не заполнены first_name или last_name
    if (!req.user.first_name || !req.user.last_name) {
        console.log(`User ${req.user.id} needs to complete profile. Redirecting to /complete-profile.`);
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
                console.warn(`Pilot with UUID ${pilotUuidFromUser} not found for user ${userId}. pilot_uuid set to NULL in users table.`);
            }
        }

        // Если pilot пуст (т.е. pilot_uuid был NULL или очищен),
        // отображаем только базовую информацию о пользователе из таблицы users
        if (!pilot || Object.keys(pilot).length === 0) {
            pilot = {
                Name: req.user.username, // Используем username из таблицы users (который теперь комбинированное имя)
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
        // Эти строки могут быть упрощены, если вы уверены, что БД возвращает NULL для пустых строк
        // или если ваш ORM/SQL запрос уже делает это. Но для безопасности можно оставить.
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
            console.warn(`Public pilot profile for ${pilotName} not found.`);
            return res.status(404).send("Пилот не найден");
        }

        const [teamsRows] = await connection.execute(`SELECT UUID, Name FROM teams ORDER BY Name`);
        const teams = teamsRows;

        // Заполняем поля по умолчанию, если они NULL
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
        console.error("Error fetching public pilot profile:", error);
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

        // Преобразуем значение чекбокса в булево (или 0/1 для БД)
        let IsTeamInterested = Boolean(req.body.IsTeamInterested);

        let errorMessage = '';

        // Валидация Shortname
        if (Shortname !== undefined && Shortname !== null && Shortname !== '') {
            if (!/^[A-Za-z]{3}$/.test(Shortname)) {
                errorMessage += 'Поле "3-Letter Shortname" має містити рівно 3 літери (A-Z).\n';
            }
        }

        // Валидация iRacingCustomerId
        if (iRacingCustomerId) {
            if (!/^[0-9]+$/.test(iRacingCustomerId)) {
                errorMessage += 'Поле "iRacing Customer ID" повинно містити лише цифри.\n';
            }
        }

        if (errorMessage) {
            return res.status(400).json({ message: errorMessage.trim() });
        }

        // Получаем текущие Shortname и TeamUUID для условного обновления
        const [currentPilotRows] = await connection.execute(
            `SELECT Shortname, TeamUUID FROM pilots WHERE UUID = ?`,
            [pilotUuidFromToken]
        );
        const currentPilotShortname = currentPilotRows[0]?.Shortname;
        const currentPilotTeamUUID = currentPilotRows[0]?.TeamUUID;

        // Используем текущий Shortname, если новый пустой
        const finalShortname = (Shortname !== undefined && Shortname !== null && Shortname !== '') ? DOMPurify.sanitize(Shortname) : currentPilotShortname;

        let newIsTeamInterested = IsTeamInterested;

        // Логика для IsTeamInterested: если выбрана новая команда или команда изменилась, сбрасываем IsTeamInterested
        if (TeamUUID && (currentPilotTeamUUID !== TeamUUID || currentPilotTeamUUID === null)) {
            newIsTeamInterested = false;
        } else if (!TeamUUID) { // Если команда не выбрана, используем значение из формы
            newIsTeamInterested = IsTeamInterested;
        }

        // Санитизация всех входящих данных
        const sanitizedDiscordId = DiscordId ? DOMPurify.sanitize(DiscordId) : null;
        const sanitizedYoutubeChannel = YoutubeChannel ? DOMPurify.sanitize(YoutubeChannel) : null;
        const sanitizedTwitchChannel = TwitchChannel ? DOMPurify.sanitize(TwitchChannel) : null;
        const sanitizedInstagram = Instagram ? DOMPurify.sanitize(Instagram) : null;
        const sanitizedTwitter = Twitter ? DOMPurify.sanitize(Twitter) : null;
        const sanitizediRacingCustomerId = iRacingCustomerId ? DOMPurify.sanitize(iRacingCustomerId) : null;
        const sanitizedCountry = Country ? DOMPurify.sanitize(Country) : null;
        const sanitizedCity = City ? DOMPurify.sanitize(City) : null;
        const sanitizedTeamUUID = TeamUUID === '' ? null : DOMPurify.sanitize(TeamUUID);


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
            return res.status(403).json({ message: "У вас немає прав для видалення фото для этого профілю." });
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

// Запуск сервера
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Open http://localhost:${port}`);
});
