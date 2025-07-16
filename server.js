require('dotenv').config();
const session = require('express-session');
const { ConnectSessionKnexStore } = require('connect-session-knex');
const KnexSessionStore = ConnectSessionKnexStore;

const db = require('./db');

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const geoip = require('geoip-lite');
const fs = require('fs');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const cookieParser = require('cookie-parser');

const app = express();
const port = process.env.PORT || 3000;
const pool = require('./db');

// Multer для загрузки файлов
const multer = require('multer');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public', 'avatars');

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
            console.log(`Created upload directory: ${uploadDir}`);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExtension = path.extname(file.originalname);
        cb(null, `temp-${uniqueSuffix}${fileExtension}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error("Error: Only images (jpeg, jpg, png, gif) are allowed!"), false);
    }
});

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// const dbConfig = {
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_DATABASE,
//     port: process.env.DB_PORT,
//     waitForConnections: true,
//     connectionLimit: 60,
//     queueLimit: 1000
// };

// const pool = mysql.createPool(dbConfig);

// --- Конфигурация Steam и сессий ---
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const STEAM_REALM = process.env.STEAM_REALM;

if (!STEAM_API_KEY || !STEAM_RETURN_URL || !SESSION_SECRET || !STEAM_REALM) {
    console.error('FATAL ERROR: STEAM_API_KEY, STEAM_RETURN_URL, SESSION_SECRET, or STEAM_REALM is not defined. Please set it in your .env file.');
    process.exit(1);
}

const cors = require('cors');

app.use(cors({
    origin: 'https://elo-rating.vercel.app',
    credentials: true
}));

passport.serializeUser((user, done) => {
    console.log("[Passport] serializeUser:", user.id);
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    console.log("[Passport] deserializeUser - Attempting to deserialize user with ID:", id);
    try {
        const rows = await db('users')
            .select('id', 'username', 'PhotoPath', 'LMUName', 'DiscordId', 'YoutubeChannel', 'TwitchChannel', 'Instagram', 'Twitter', 'iRacingCustomerId', 'Country', 'City', 'TeamUUID', 'IsTeamInterested', 'steam_id_64', 'first_name', 'last_name')
            .where('id', id);

        const user = rows[0];
        if (!user) {
            console.warn("[Passport] deserializeUser - User not found for ID:", id);
            return done(null, false);
        }

        const defaultAvatarPath = '/avatars/default_avatar_64.png';
        if (user.PhotoPath === null || user.PhotoPath === undefined || user.PhotoPath === '') {
            user.PhotoPath = defaultAvatarPath;
            console.log(`[Passport] deserializeUser - User ${user.id} had NULL/empty PhotoPath, set to default.`);
        }

        console.log("[Passport] deserializeUser - Successfully deserialized user:", user.username, "ID:", user.id, "Steam ID:", user.steam_id_64, "PhotoPath:", user.PhotoPath);
        done(null, user);
    } catch (err) {
        console.error("Error in deserializeUser:", err);
        done(err);
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
        const steamDisplayName = profile.displayName;
        console.log("[Passport] SteamStrategy: identifier =", identifier);
        console.log("[Passport] SteamStrategy: profile =", profile);
        let connection;
        try {
            const userRows = await db('users')
                .select('id', 'steam_id_64', 'pilot_uuid', 'username', 'first_name', 'last_name', 'is_admin')
                .where('steam_id_64', steamId64);
            let user = userRows[0];
            let pilotUuidToLink = null;

            const [pilotRows] = await connection.execute(
                `SELECT UUID FROM pilots WHERE steam_id_64 = ?`,
                [steamId64]
            );
            if (pilotRows.length > 0) {
                pilotUuidToLink = pilotRows[0].UUID;
                console.log(`[SteamStrategy] Found existing pilot UUID ${pilotUuidToLink} for Steam ID ${steamId64}`);
            }

            if (user) {
                console.log("[SteamStrategy] Existing user found in `users` table:", user.id);
                if (!user.pilot_uuid && pilotUuidToLink) {
                    console.log(`[SteamStrategy] Linking existing pilot ${pilotUuidToLink} to user ${user.id}`);
                    await connection.execute(
                        `UPDATE users SET pilot_uuid = ? WHERE id = ?`,
                        [pilotUuidToLink, user.id]
                    );
                    user.pilot_uuid = pilotUuidToLink;
                }

                if (user.username === '' || user.username === steamId64) {
                    console.log(`[SteamStrategy] Updating username for user ${user.id} to Steam Display Name: ${steamDisplayName}`);
                    await connection.execute(
                        `UPDATE users SET username = ? WHERE id = ?`,
                        [steamDisplayName, user.id]
                    );
                    user.username = steamDisplayName;
                }

                await connection.execute(
                    `UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [user.id]
                );

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
                console.log("[SteamStrategy] New Steam user. Creating new entry in `users` table.");

                const [insertResult] = await connection.execute(
                    `INSERT INTO users (steam_id_64, username, first_name, last_name, pilot_uuid, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [steamId64, steamDisplayName, '', '', pilotUuidToLink]
                );
                const newUserId = insertResult.insertId;

                const [newUserRows] = await connection.execute(
                    `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin FROM users WHERE id = ?`,
                    [newUserId]
                );
                const newUser = newUserRows[0];
                console.log("[SteamStrategy] New user created:", newUser);
                return done(null, newUser);
            }
        } catch (error) {
            console.error("[SteamStrategy] Error during Steam authentication strategy:", error);
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

const store = new KnexSessionStore({
    knex: db,            // ваш объект knex (из db.js)
    tablename: 'sessions',
    createtable: true,
    sidfieldname: 'sid',
    clearInterval: 600000 // Очистка просроченных сессий каждые 10 мин
});


app.set('trust proxy', 1);

// Настройка сессий
app.use(session({
    secret: process.env.SESSION_SECRET || 'defaultsecret',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 дней
    }
}));

// Инициализация Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware для добавления информации о пользователе в res.locals для EJS
app.use((req, res, next) => {
    console.log("[Session Check] Cookie headers:", req.headers.cookie);
    console.log("[Session Check] Session ID:", req.sessionID);
    console.log("[Session Check] Session:", req.session);

    if (req.isAuthenticated() && req.user) {
        // Если first_name и last_name заполнены, используем их для username
        if (req.user.first_name && req.user.first_name.trim().length > 0 &&
            req.user.last_name && req.user.last_name.trim().length > 0) {
            res.locals.user = {
                ...req.user,
                username: `${req.user.first_name.trim()} ${req.user.last_name.trim()}`
            };
        } else {
            // Если first_name/last_name не заполнены, используем username из базы (Steam Display Name)
            // Убедимся, что username всегда является строкой
            res.locals.user = {
                ...req.user,
                username: req.user.username || '' // Fallback to empty string if username is null/undefined
            };
        }
        console.log(`[res.locals.user Middleware] res.locals.user (after processing):`, res.locals.user);
    } else {
        res.locals.user = null;
        console.log(`[res.locals.user Middleware] User not authenticated, res.locals.user set to null.`);
    }
    next();
});

// Middleware для проверки, заполнено ли имя пользователя (для новых Steam-пользователей)
const checkUsernameCompletion = async (req, res, next) => {
    console.log(`[checkUsernameCompletion] Path: ${req.path}`);
    console.log(`[checkUsernameCompletion] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[checkUsernameCompletion] req.user (at start of middleware):`, req.user);

    // Дополнительная проверка, чтобы избежать ошибки, если req.user действительно undefined
    if (!req.user) {
        console.warn("[checkUsernameCompletion] req.user is undefined despite isAuthenticated() potentially being true. Skipping check.");
        return next();
    }

    // Определяем пути, которые не требуют полного профиля для доступа
    const allowedPaths = [
        '/complete-profile',
        '/auth/steam',
        '/auth/steam/return',
        '/logout',
        '/api/events',
        '/track-view',
        '/',
        '/api/search-pilots',
        '/teams',
        '/team/',
        '/events',
        '/event/',
        '/race/',
        '/login',
        '/rules',
        '/contacts',
        '/privacy-policy',
        '/tracks',
        '/api/tracks',
        '/new-participants',
        '/analytics',
    ];

    // Проверяем, находится ли текущий путь в списке разрешенных
    const isAllowedPath = allowedPaths.some(path => req.path === path || req.path.startsWith(path + '/'));

    // Если пользователь авторизован, но у него не заполнены first_name ИЛИ last_name
    if (req.isAuthenticated() && (!req.user.first_name || req.user.first_name.trim().length === 0 ||
        !req.user.last_name || req.user.last_name.trim().length === 0)) {

        // Если пользователь пытается получить доступ к любой странице, кроме разрешенных
        if (!isAllowedPath) {
            console.log(`[checkUsernameCompletion] Redirecting user ${req.user.id} to /complete-profile as first_name or last_name is missing.`);
            return res.redirect('/complete-profile');
        }
    }
    next(); // Продолжаем выполнение запроса
};
app.use(checkUsernameCompletion);

function checkAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect("/login");
}

// --- Маршруты аутентификации Steam ---

app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    async (req, res) => {
        console.log(`[auth/steam/return] Successful authentication. req.user (from Passport SteamStrategy):`, req.user);

        let connection;
        try {
            const steamId64 = req.user.id;
            const steamDisplayName = req.user.displayName;

            const userRows = await db('users')
                .select('id', 'steam_id_64', 'pilot_uuid', 'username', 'first_name', 'last_name', 'is_admin', 'PhotoPath')
                .where('steam_id_64', steamId64);

            let userInDb = userRows[0];

            const defaultPhotoPath = '/avatars/default_avatar_64.png';
            let currentPilotUuid = null;

            const [pilotRows] = await connection.execute(
                `SELECT UUID FROM pilots WHERE steam_id_64 = ?`,
                [steamId64]
            );
            if (pilotRows.length > 0) {
                currentPilotUuid = pilotRows[0].UUID;
                console.log(`[auth/steam/return] Found existing pilot UUID ${currentPilotUuid} for Steam ID ${steamId64}`);
            }

            if (!userInDb) {
                console.log("[auth/steam/return] === DEBUG: Entering NEW USER creation block ===");
                const defaultPhotoPath = '/avatars/default_avatar_64.png';
                console.log(`[auth/steam/return] DEBUG: defaultPhotoPath defined as: ${defaultPhotoPath}`);

                const [insertResult] = await connection.execute(
                    `INSERT INTO users (steam_id_64, username, first_name, last_name, pilot_uuid, PhotoPath, registered_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [steamId64, steamDisplayName, '', '', currentPilotUuid, defaultPhotoPath]
                );
                console.log(`[auth/steam/return] DEBUG: INSERT query executed. insertResult:`, insertResult);
                userInDb = {
                    id: insertResult.insertId,
                    steam_id_64: steamId64,
                    username: steamDisplayName,
                    first_name: '',
                    last_name: '',
                    pilot_uuid: currentPilotUuid,
                    PhotoPath: defaultPhotoPath,
                    is_admin: 0
                };
                console.log("[auth/steam/return] DEBUG: userInDb object after creation:", userInDb);
                Object.assign(req.user, userInDb);
                console.log("[auth/steam/return] DEBUG: req.user after Object.assign:", req.user);
                console.log("[auth/steam/return] === DEBUG: Exiting NEW USER creation block ===");
            } else {
                console.log("[auth/steam/return] === DEBUG: Entering EXISTING USER update block ===");

                if (!userInDb.pilot_uuid && currentPilotUuid) {
                    console.log(`[auth/steam/return] Linking existing pilot ${currentPilotUuid} to user ${userInDb.id}`);
                    await connection.execute(
                        `UPDATE users SET pilot_uuid = ? WHERE id = ?`,
                        [currentPilotUuid, userInDb.id]
                    );
                    userInDb.pilot_uuid = currentPilotUuid;
                }

                if (userInDb.username === '' || userInDb.username === steamId64) {
                    console.log(`[auth/steam/return] Updating username for user ${userInDb.id} to Steam Display Name: ${steamDisplayName}`);
                    await connection.execute(
                        `UPDATE users SET username = ? WHERE id = ?`,
                        [steamDisplayName, userInDb.id]
                    );
                    userInDb.username = steamDisplayName;
                }

                if (userInDb.PhotoPath === null || userInDb.PhotoPath === undefined || userInDb.PhotoPath === '') {
                    console.log(`[auth/steam/return] Updating PhotoPath for existing user ${userInDb.id} to default.`);
                    await connection.execute(
                        `UPDATE users SET PhotoPath = ? WHERE id = ?`,
                        [defaultPhotoPath, userInDb.id]
                    );
                    userInDb.PhotoPath = defaultPhotoPath;
                }

                await connection.execute(
                    `UPDATE users SET last_login_at = NOW() WHERE id = ?`,
                    [userInDb.id]
                );
                Object.assign(req.user, userInDb);
            }

            if (!req.user.first_name || req.user.first_name.trim().length === 0 ||
                !req.user.last_name || req.user.last_name.trim().length === 0) {
                console.log(`[auth/steam/return] User ${req.user.id} needs to complete profile. Redirecting to /complete-profile.`);
                return res.redirect('/complete-profile');
            }

            if (req.user.pilot_uuid) {
                const [pilotNameRow] = await connection.execute(
                    `SELECT Name FROM pilots WHERE UUID = ?`,
                    [req.user.pilot_uuid]
                );
                const pilotName = pilotNameRow[0]?.Name;
                if (pilotName) {
                    console.log(`[auth/steam/return] User ${req.user.id} (Pilot ${pilotName}) redirected to /profile/${encodeURIComponent(pilotName)}`);
                    return res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
                }
            }

            console.log(`[auth/steam/return] User ${req.user.id} is authenticated but not linked to a pilot or pilot name not found. Redirecting to /profile.`);
            return res.redirect('/profile');

        } catch (error) {
            console.error("[auth/steam/return] Error during Steam authentication processing:", error);
            return res.redirect('/'); // В случае серьезной ошибки перенаправляем на главную
        } finally {
            if (connection) connection.release();
        }
    });

app.get('/logout', (req, res, next) => {
    console.log(`[logout] User ${req.user ? req.user.id : 'N/A'} attempting to log out.`);
    req.logout((err) => {
        if (err) {
            console.error("[logout] Error during req.logout:", err);
            return next(err);
        }
        req.session.destroy((err) => {
            if (err) {
                console.error('[logout] Error destroying session:', err);
                return next(err);
            }
            res.clearCookie('connect.sid');
            console.log("[logout] User logged out and session destroyed. Redirecting to /.");
            res.redirect('/');
        });
    });
});

// --- Маршруты для заполнения имени/фамилии (только для новых пользователей) ---
app.get('/complete-profile', (req, res) => {
    console.log(`[complete-profile GET] Path: ${req.path}`);
    console.log(`[complete-profile GET] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[complete-profile GET] req.user:`, req.user);
    console.log("req.session:", req.session);

    // Если пользователь не авторизован, перенаправляем на главную
    if (!req.isAuthenticated()) {
        console.log(`[complete-profile GET] User not authenticated. Redirecting to /.`);
        return res.redirect('/');
    }

    // Если пользователь авторизован И его имя И фамилия УЖЕ ЗАПОЛНЕНЫ, перенаправляем на главную
    // Используем .trim().length > 0 для надежной проверки на пустые строки
    if (req.user.first_name && req.user.first_name.trim().length > 0 &&
        req.user.last_name && req.user.last_name.trim().length > 0) {
        console.log(`[complete-profile GET] User ${req.user.id} already completed profile. Redirecting to /.`);
        return res.redirect('/');
    }

    // Иначе, рендерим страницу заполнения профиля
    res.render('complete_profile', {
        message: null,
        messageType: null,
        activeMenu: 'complete-profile',
        first_name: req.user.first_name || '',
        last_name: req.user.last_name || ''
    });
});

app.post("/complete-profile", checkAuthenticated, async (req, res) => {
    try {
        const { first_name, last_name } = req.body;
        const userId = req.user.id;
        const username = `${first_name} ${last_name}`;

        // Обновляем профиль пользователя
        await db('users')
            .where('id', userId)
            .update({
                first_name,
                last_name,
                username
            });

        // Обновляем сессионного пользователя
        req.user.first_name = first_name;
        req.user.last_name = last_name;
        req.user.username = username;

        req.session.save(async (err) => {
            if (err) {
                console.error("Ошибка сохранения сессии после обновления профиля:", err);
                return res.status(500).render("complete_profile", {
                    message: "Помилка збереження сесії. Спробуйте ще раз.",
                    messageType: "danger"
                });
            }

            let pilotName = null;
            if (req.user.pilot_uuid) {
                const pilotRows = await db('pilots')
                    .select('Name')
                    .where('UUID', req.user.pilot_uuid);

                if (pilotRows.length > 0) {
                    pilotName = pilotRows[0].Name;
                }
            }

            if (pilotName) {
                res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
            } else {
                res.redirect("/profile");
            }
        });

    } catch (error) {
        console.error("Ошибка завершения профиля:", error);
        res.status(500).render("complete_profile", {
            message: "Помилка збереження даних. Спробуйте ще раз.",
            messageType: "danger"
        });
    }
});

app.get("/", async (req, res) => {
    console.log(`[Root GET] Path: ${req.path}`);
    console.log(`[Root GET] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[Root GET] req.user:`, req.user);

    try {
        const rows = await db('pilots')
            .select('Name', 'EloRanking', 'RaceCount', 'UUID', 'AverageChange')
            .orderBy('EloRanking', 'desc');

        console.log("Pilots data:", rows.length > 0 ? `Fetched ${rows.length} pilots.` : 'No pilots found.');
        res.render("pilots", { pilots: rows, activeMenu: 'pilots' });
    } catch (error) {
        console.error("[Root GET] Error fetching data for / (root):", error);
        res.status(500).send("Error fetching data");
    }
});


app.get("/pilot/:name", async (req, res) => {
    const pilotName = req.params.name;

    try {
        console.log(`[Pilot Profile GET] Fetching data for pilot: ${pilotName}`);

        // 1. Найти UUID пилота по имени
        const pilotLookupRows = await db('pilots')
            .select('UUID')
            .where('Name', pilotName);

        if (pilotLookupRows.length === 0) {
            console.warn(`[Pilot Profile GET] Pilot with name ${pilotName} not found.`);
            return res.status(404).send("Pilot not found");
        }

        const pilotUUID = pilotLookupRows[0].UUID;

        // 2. Получить данные для построения графика ELO
        const eloRaceRows = await db('raceparticipants as rp')
            .join('pilots as p', 'rp.PilotUUID', 'p.UUID')
            .join('races as r', 'rp.RaceUUID', 'r.UUID')
            .select('r.StartDate as Date', 'rp.EloChange')
            .where('p.UUID', pilotUUID)
            .orderBy('r.StartDate');

        let cumulativeElo = 1500;
        const eloChartData = eloRaceRows.map((race) => {
            const date = new Date(race.Date);
            const utcDate = new Date(date.toISOString());
            cumulativeElo += race.EloChange;
            return {
                Date: utcDate.toISOString(),
                CumulativeElo: cumulativeElo,
            };
        });

        // 3. Получить статистику пилота
        const pilotStatsRows = await db('pilots')
            .select(
                'RaceCount',
                'Wins',
                'Podiums',
                'Top5',
                'Top10',
                'PodiumPercentage'
            )
            .where('UUID', pilotUUID);

        const pilotStats = pilotStatsRows[0] || {
            RaceCount: 0,
            Wins: 0,
            Podiums: 0,
            Top5: 0,
            Top10: 0,
            PodiumPercentage: 0,
        };

        // 4. Ответ JSON
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
        console.error("[Pilot Profile GET] Error fetching pilot data:", error);
        res.status(500).send("Error fetching pilot data");
    }
});

app.get("/profile", checkAuthenticated, async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect("/login");
    }

    const userId = req.user.id;

    try {
        // Получаем данные пользователя
        const userRows = await db('users')
            .select(
                'LMUName',
                'DiscordId',
                'YoutubeChannel',
                'TwitchChannel',
                'Instagram',
                'Twitter',
                'iRacingCustomerId',
                'Country',
                'City',
                'TeamUUID',
                'IsTeamInterested',
                'PhotoPath',
                'first_name',
                'last_name'
            )
            .where({ id: userId });

        const userProfile = userRows[0] || {};

        // Получаем список команд
        const teamRows = await db('teams').select('UUID', 'Name');

        const availableTeams = teamRows.map(team => ({
            uuid: team.UUID,
            name: team.Name
        }));

        res.render("profile", {
            userProfile,
            teams: availableTeams,
            activeMenu: 'profile',
            isAuthenticated: req.isAuthenticated(),
            user: req.user
        });

    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).send("Error fetching user profile data.");
    }
});


app.post('/profile/update', async (req, res) => {
    console.log(`[profile/update POST] Path: ${req.path}`);
    console.log(`[profile/update POST] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[profile/update POST] req.user:`, req.user);
    console.log(`[profile/update POST] req.body:`, req.body);

    if (!req.isAuthenticated() || !req.user) {
        console.warn("[profile/update POST] User not authenticated or user object missing. Sending 401.");
        return res.status(401).json({ success: false, message: "Не авторизовано. Будь ласка, увійдіть." });
    }

    const userId = req.user.id;
    const {
        iRacingCustomerId,
        LMUName,
        DiscordId,
        YoutubeChannel,
        TwitchChannel,
        Instagram,
        Twitter,
        Country,
        City,
        TeamUUID,
        IsTeamInterested,
        first_name,
        last_name
    } = req.body;

    const sanitizedIRacingCustomerId = DOMPurify.sanitize(iRacingCustomerId || '').trim();
    const sanitizedLMUName = DOMPurify.sanitize(LMUName || '').trim();
    const sanitizedDiscordId = DOMPurify.sanitize(DiscordId || '').trim();
    const sanitizedYoutubeChannel = DOMPurify.sanitize(YoutubeChannel || '').trim();
    const sanitizedTwitchChannel = DOMPurify.sanitize(TwitchChannel || '').trim();
    const sanitizedInstagram = DOMPurify.sanitize(Instagram || '').trim();
    const sanitizedTwitter = DOMPurify.sanitize(Twitter || '').trim();
    const sanitizedCountry = DOMPurify.sanitize(Country || '').trim();
    const sanitizedCity = DOMPurify.sanitize(City || '').trim();
    const sanitizedFirstName = DOMPurify.sanitize(first_name || '').trim();
    const sanitizedLastName = DOMPurify.sanitize(last_name || '').trim();
    const finalTeamUUID = (TeamUUID === '' || TeamUUID === undefined || TeamUUID === null) ? null : DOMPurify.sanitize(TeamUUID).trim();

    if (sanitizedIRacingCustomerId && !/^[0-9]+$/.test(sanitizedIRacingCustomerId)) {
        return res.status(400).json({ success: false, message: 'Поле "iRacing Customer ID" повинно містити лише цифри.' });
    }

    const latinRegex = /^[a-zA-Z]+$/;
    if (!sanitizedFirstName || !latinRegex.test(sanitizedFirstName)) {
        return res.status(400).json({ success: false, message: 'Ім\'я повинно містити лише латинські літери і не бути пустим.' });
    }
    if (!sanitizedLastName || !latinRegex.test(sanitizedLastName)) {
        return res.status(400).json({ success: false, message: 'Прізвище повинно містити лише латинські літери і не бути пустим.' });
    }

    const newUsername = `${sanitizedFirstName} ${sanitizedLastName}`;

    let finalIsTeamInterested = (IsTeamInterested === true || IsTeamInterested === 'on' || IsTeamInterested === 1) ? 1 : 0;
    if (finalTeamUUID) finalIsTeamInterested = 0;

    const updateData = {
        first_name: sanitizedFirstName,
        last_name: sanitizedLastName,
        username: newUsername,
        iRacingCustomerId: sanitizedIRacingCustomerId,
        LMUName: sanitizedLMUName,
        DiscordId: sanitizedDiscordId,
        YoutubeChannel: sanitizedYoutubeChannel,
        TwitchChannel: sanitizedTwitchChannel,
        Instagram: sanitizedInstagram,
        Twitter: sanitizedTwitter,
        Country: sanitizedCountry,
        City: sanitizedCity,
        TeamUUID: finalTeamUUID,
        IsTeamInterested: finalIsTeamInterested
    };

    try {
        const result = await db('users')
            .where({ id: userId })
            .update(updateData);

        if (result === 0) {
            return res.status(404).json({ success: false, message: "Користувач не знайдений або немає змін для збереження" });
        }

        // Обновляем req.user
        Object.assign(req.user, updateData);

        req.session.save((err) => {
            if (err) {
                console.error("[profile/update POST] Error saving session:", err);
                return res.status(500).json({ success: false, message: "Помилка збереження сесії." });
            }
            console.log(`[profile/update POST] User ${userId} profile updated successfully and session saved.`);
            res.json({ success: true, message: "Профіль оновлено" });
        });

    } catch (error) {
        console.error("[profile/update POST] Error updating user profile:", error);
        res.status(500).json({ success: false, message: "Помилка сервера при оновленні профілю" });
    }
});


app.post("/profile/upload-photo", upload.single('photo'), async (req, res) => {
    if (!req.isAuthenticated()) {
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting temporary file for unauthenticated user:', err);
            });
        }
        return res.status(403).json({ message: "У вас немає прав для завантаження фото" });
    }

    const userId = req.user.id;
    console.log(`[upload-photo] User ID: ${userId}`);
    console.log("Received file upload:", req.file);

    if (!req.file) {
        return res.status(400).json({ message: "Файл не завантажено" });
    }

    try {
        const user = await db('users')
            .select('PhotoPath')
            .where({ id: userId })
            .first();

        const oldPhotoPath = user?.PhotoPath;
        const fileExtension = path.extname(req.file.originalname);
        const newFilename = `${userId}-${Date.now()}${fileExtension}`;
        const newPhotoPath = `/avatars/${newFilename}`;
        const newFilePath = path.join(__dirname, 'public', 'avatars', newFilename);

        await fs.promises.rename(req.file.path, newFilePath);
        console.log(`[upload-photo] Renamed temporary file ${req.file.filename} to ${newFilename}`);

        // Удаляем старое фото (если оно не дефолтное)
        if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
            const oldFilePath = path.join(__dirname, 'public', oldPhotoPath);
            fs.unlink(oldFilePath, (err) => {
                if (err) console.error('Error deleting old photo file:', err);
                else console.log(`[upload-photo] Deleted old photo: ${oldFilePath}`);
            });
        }

        await db('users')
            .where({ id: userId })
            .update({ PhotoPath: newPhotoPath });

        console.log(`[upload-photo] Database updated with new PhotoPath: ${newPhotoPath}`);

        req.user.PhotoPath = newPhotoPath;

        res.status(200).json({
            message: "Фото успішно завантажено",
            photoPath: newPhotoPath
        });

    } catch (error) {
        console.error("Error uploading photo:", error);
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting temporary file after processing error:', err);
            });
        }
        res.status(500).json({ message: "Помилка при завантаженні фото", error: error.message });
    }
});


app.delete("/profile/delete-photo", async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(403).json({ message: "У вас немає прав для видалення фото." });
    }

    const userId = req.user.id;

    try {
        const user = await db("users")
            .select("PhotoPath")
            .where({ id: userId })
            .first();

        const oldPhotoPath = user?.PhotoPath;
        const defaultAvatarPath = "/avatars/default_avatar_64.png";

        if (oldPhotoPath && oldPhotoPath !== defaultAvatarPath) {
            const filePath = path.join(__dirname, "public", oldPhotoPath);
            fs.unlink(filePath, (err) => {
                if (err) console.error("Error deleting old photo file:", err);
                else console.log(`[delete-photo] Deleted photo file: ${filePath}`);
            });
        }

        await db("users")
            .where({ id: userId })
            .update({ PhotoPath: defaultAvatarPath });

        req.user.PhotoPath = defaultAvatarPath;

        res.status(200).json({
            message: "Фото видалено",
            photoPath: defaultAvatarPath
        });

    } catch (error) {
        console.error("Помилка видалення фото:", error);
        res.status(500).json({ message: "Помилка видалення фото", error: error.message });
    }
});


app.get("/profile/:pilotName", async (req, res) => {
    const pilotName = req.params.pilotName;

    try {
        const pilot = await db("pilots")
            .select("Name", "DiscordId", "YoutubeChannel", "TwitchChannel", "Instagram", "Twitter", "iRacingCustomerId", "Country", "City", "PhotoPath", "TeamUUID", "IsTeamInterested")
            .where({ Name: pilotName })
            .first();

        if (!pilot) {
            console.warn(`[Public Profile GET] Public pilot profile for ${pilotName} not found.`);
            return res.status(404).send("Пілот не знайдений");
        }

        const teams = await db("teams").select("UUID", "Name").orderBy("Name");

        // Подставляем значения по умолчанию
        pilot.PhotoPath = pilot.PhotoPath || '/avatars/default_avatar_64.png';
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

        res.render("profile", {
            pilot,
            teams,
            activeMenu: 'profile'
        });

    } catch (error) {
        console.error("[Public Profile GET] Error fetching public pilot profile:", error);
        res.status(500).send("Помилка завантаження профілю");
    }
});


app.get("/new-participants", async (req, res) => {
    try {
        const rows = await db("raceparticipants as rp")
            .join("races as r", "rp.RaceUUID", "r.UUID")
            .select("rp.PilotUUID", "rp.RaceUUID", "r.StartDate")
            .orderBy("r.StartDate");

        const races = {};
        const cumulativeParticipantsCount = [];
        const newParticipantsCount = [];
        const raceDates = [];
        const allParticipants = new Set();

        rows.forEach((row) => {
            const date = new Date(row.StartDate).toISOString().split("T")[0];
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
    }
});


app.get("/tracks", async (req, res) => {
  try {
    console.log("Connected to database for tracks page.");

    // Основные треки с изображениями
    const tracks = await db("trackrecords as tr")
      .leftJoin("trackimages as ti", "tr.TrackName", "ti.TrackName")
      .select(
        "tr.TrackName",
        "tr.BestQualifyingLapTime",
        "tr.BestQualifyingLapPilot",
        "tr.BestRaceLapTime",
        "tr.BestRaceLapPilot",
        "ti.ImagePath"
      )
      .orderBy("tr.TrackName");

    // Топ пилотов по количеству гонок
    const topRaceCountPilots = await db("pilots")
      .select("Name", "RaceCount")
      .orderBy("RaceCount", "desc")
      .limit(15);

    // Топ по победам
    const topWinsPilots = await db("pilots")
      .select("Name", "Wins")
      .orderBy("Wins", "desc")
      .limit(15);

    // Топ по подиумам
    const topPodiumsPilots = await db("pilots")
      .select("Name", "Podiums")
      .orderBy("Podiums", "desc")
      .limit(15);

    // Топ по поулам (лучшие квалификации)
    const topPolesPilots = await db("trackrecords")
      .select("BestQualifyingLapPilot as Name")
      .count("UUID as PoleCount")
      .whereNotNull("BestQualifyingLapPilot")
      .andWhere("BestQualifyingLapPilot", "!=", "")
      .groupBy("BestQualifyingLapPilot")
      .orderBy("PoleCount", "desc")
      .limit(15);

    // Топ по быстрым кругам гонки
    const topFastestLapsPilots = await db("trackrecords")
      .select("BestRaceLapPilot as Name")
      .count("UUID as FastestLapCount")
      .whereNotNull("BestRaceLapPilot")
      .andWhere("BestRaceLapPilot", "!=", "")
      .groupBy("BestRaceLapPilot")
      .orderBy("FastestLapCount", "desc")
      .limit(15);

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
      activeMenu: "tracks",
    });
  } catch (error) {
    console.error("Error fetching data for tracks page:", error);
    res.status(500).send("Error fetching data for tracks page");
  }
});


app.get("/api/events", async (req, res) => {
  try {
    const rows = await db("events")
      .select("id", "date", "description", "url")
      .orderBy("date");

    res.json({ events: rows });
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).send("Error fetching events");
  }
});


app.get("/calendar", async (req, res) => {
  try {
    const rows = await db("events")
      .select("id", "date", "description", "url")
      .orderBy("date");

    console.log("Events data:", rows);
    res.render("calendar", { events: rows, activeMenu: 'calendar' });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).send("Error fetching data");
  }
});


app.post("/track-view", async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const pageUrl = req.headers.referer || req.headers.referrer || req.originalUrl;

    let processedIp = ip;

    if (ip && ip.includes('.') && ip.split('.').length === 4) {
      const parts = ip.split('.');
      processedIp = parts[0] + '.' + parts[1] + '.' + parts[2] + '.0';
    } else if (ip && ip.includes(':')) {
      const parts = ip.split(':');
      if (parts.length > 4) {
        processedIp = parts.slice(0, Math.ceil(parts.length / 2)).join(':') + '::';
      }
    }

    const geo = geoip.lookup(processedIp);
    const countryCode = geo ? geo.country : 'XX';

    console.log(`Tracking view from IP: ${ip} (processed: ${processedIp}), Country: ${countryCode}, User-Agent: ${userAgent}, Page: ${pageUrl}`);

    await db('page_views').insert({
      ip_address: processedIp,
      country: countryCode,
      user_agent: userAgent,
      page_url: pageUrl
    });

    res.status(200).send("View tracked successfully");
  } catch (error) {
    console.error("Error tracking view:", error);
    res.status(500).send("Error tracking view");
  }
});


app.get("/analytics", async (req, res) => {
  try {
    const uniqueVisitorsResult = await db('page_views')
      .countDistinct('ip_address as count');
    const uniqueVisitorsCount = uniqueVisitorsResult[0].count;

    const viewsByPage = await db('page_views')
      .select('page_url')
      .countDistinct('ip_address as count')
      .groupBy('page_url')
      .orderBy('count', 'desc');

    const viewsByCountry = await db('page_views')
      .select('country')
      .countDistinct('ip_address as count')
      .groupBy('country')
      .orderBy('count', 'desc');

    const uniqueVisitorsTodayResult = await db('page_views')
      .countDistinct('ip_address as count')
      .where('visit_time', '>=', db.raw('CURDATE()'));
    const uniqueVisitorsTodayCount = uniqueVisitorsTodayResult[0].count;

    const uniqueVisitorsThisWeekResult = await db('page_views')
      .countDistinct('ip_address as count')
      .where('visit_time', '>=', db.raw('CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY'));
    const uniqueVisitorsThisWeekCount = uniqueVisitorsThisWeekResult[0].count;

    const uniqueVisitorsThisMonthResult = await db('page_views')
      .countDistinct('ip_address as count')
      .where('visit_time', '>=', db.raw("DATE_FORMAT(CURDATE(), '%Y-%m-01')"));
    const uniqueVisitorsThisMonthCount = uniqueVisitorsThisMonthResult[0].count;

    const uniqueVisitorsLastWeekResult = await db('page_views')
      .countDistinct('ip_address as count')
      .whereBetween('visit_time', [
        db.raw('CURDATE() - INTERVAL (WEEKDAY(CURDATE()) + 7) DAY'),
        db.raw('CURDATE() - INTERVAL WEEKDAY(CURDATE()) DAY')
      ]);
    const uniqueVisitorsLastWeekCount = uniqueVisitorsLastWeekResult[0].count;

    const uniqueVisitorsLastMonthResult = await db('page_views')
      .countDistinct('ip_address as count')
      .whereBetween('visit_time', [
        db.raw("DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')"),
        db.raw("DATE_FORMAT(CURDATE(), '%Y-%m-01')")
      ]);
    const uniqueVisitorsLastMonthCount = uniqueVisitorsLastMonthResult[0].count;

    const uniqueVisitorsLastYearResult = await db('page_views')
      .countDistinct('ip_address as count')
      .whereBetween('visit_time', [
        db.raw("DATE_FORMAT(CURDATE() - INTERVAL 1 YEAR, '%Y-01-01')"),
        db.raw("DATE_FORMAT(CURDATE(), '%Y-01-01')")
      ]);
    const uniqueVisitorsLastYearCount = uniqueVisitorsLastYearResult[0].count;

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
  }
});


// Запуск сервера
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Open http://localhost:${port}`);
});
