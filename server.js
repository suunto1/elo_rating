require('dotenv').config();
const express = require("express");
const cors = require('cors');
const session = require("express-session");
const { ConnectSessionKnexStore } = require("connect-session-knex");
const KnexSessionStore = ConnectSessionKnexStore;

const path = require("path");
const fs = require("fs");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const cookieParser = require("cookie-parser");
const geoip = require("geoip-lite");

const db = require("./db");
const knex = db;
// 🛡️ Защита от необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('SIGINT', async () => {
    console.log('[DB] Shutting down DB connections...');
    await db.destroy();
    process.exit(0);
});

// 🔁 Тест подключения к БД
async function connectWithRetry(retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await db.raw('SELECT 1');
            console.log('✅ DB connection successful');
            return;
        } catch (err) {
            console.error(`❌ DB connection failed (attempt ${i + 1}/${retries}):`, err.code);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, 5000)); // ждём 5 сек
            } else {
                console.error('❌ Could not connect to DB after retries. Exiting.');
                process.exit(1);
            }
        }
    }
}

connectWithRetry();

const app = express();
app.get('/ping', (req, res) => {
    res.send('OK');
});
const port = process.env.PORT || 3000;

// Multer для загрузки файлов
const multer = require('multer');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public', 'avatars');

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
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

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const STEAM_REALM = process.env.STEAM_REALM;

if (!STEAM_API_KEY || !STEAM_RETURN_URL || !SESSION_SECRET || !STEAM_REALM) {
    console.error('FATAL ERROR: STEAM_API_KEY, STEAM_RETURN_URL, SESSION_SECRET, or STEAM_REALM is not defined. Please set it in your .env file.');
    process.exit(1);
}

app.use(cors({
    origin: 'https://elo-rating.vercel.app',
    credentials: true
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const rows = await db('users')
            .select('id', 'username', 'PhotoPath', 'LMUName', 'DiscordId', 'YoutubeChannel', 'TwitchChannel', 'Instagram', 'Twitter', 'iRacingCustomerId', 'Country', 'City', 'TeamUUID', 'IsTeamInterested', 'steam_id_64', 'first_name', 'last_name')
            .where('id', id);

        const user = rows[0];
        if (!user) {
            return done(null, false);
        }

        const defaultAvatarPath = '/avatars/default_avatar_64.png';
        if (user.PhotoPath === null || user.PhotoPath === undefined || user.PhotoPath === '') {
            user.PhotoPath = defaultAvatarPath;
        }
        done(null, user);
    } catch (err) {
        console.error("Error in deserializeUser:", err);
        done(err);
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

        try {
            const userRows = await db('users')
                .select('id', 'steam_id_64', 'pilot_uuid', 'username', 'first_name', 'last_name', 'is_admin')
                .where('steam_id_64', steamId64);
            let user = userRows[0];

            const pilotRows = await db('pilots').select('UUID').where('steam_id_64', steamId64);
            let pilotUuidToLink = pilotRows.length > 0 ? pilotRows[0].UUID : null;

            if (user) {
                if (!user.pilot_uuid && pilotUuidToLink) {
                    await db('users').where('id', user.id).update({ pilot_uuid: pilotUuidToLink });
                    user.pilot_uuid = pilotUuidToLink;
                }

                if (user.username === '' || user.username === steamId64) {
                    await db('users').where('id', user.id).update({ username: steamDisplayName });
                    user.username = steamDisplayName;
                }

                await db('users').where('id', user.id).update({ last_login_at: db.fn.now() });

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
                const [newUserId] = await db('users').insert({
                    steam_id_64: steamId64,
                    username: steamDisplayName,
                    first_name: '',
                    last_name: '',
                    pilot_uuid: pilotUuidToLink,
                    last_login_at: db.fn.now(),
                    registered_at: db.fn.now()
                });

                const newUserRows = await db('users')
                    .select('id', 'steam_id_64', 'pilot_uuid', 'username', 'first_name', 'last_name', 'is_admin')
                    .where('id', newUserId);
                const newUser = newUserRows[0];
                return done(null, newUser);
            }
        } catch (error) {
            console.error("[SteamStrategy] Error during Steam authentication strategy:", error);
            return done(error);
        }
    }));

// --- Middleware ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    store: new KnexSessionStore({
        knex: knex,  // или knex, если эта переменная уже определена
        tablename: 'sessions',
        createtable: true,
        sidfieldname: 'sid',
        clearInterval: 60000 // 60 секунд — будет удалять просроченные сессии
    }),
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
        secure: true,
        sameSite: 'none',
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Middleware для добавления информации о пользователе в res.locals для EJS
app.use((req, res, next) => {
    if (req.isAuthenticated() && req.user) {
        if (req.user.first_name && req.user.first_name.trim().length > 0 &&
            req.user.last_name && req.user.last_name.trim().length > 0) {
            res.locals.user = {
                ...req.user,
                username: `${req.user.first_name.trim()} ${req.user.last_name.trim()}`
            };
        } else {
            res.locals.user = {
                ...req.user,
                username: req.user.username || ''
            };
        }
    } else {
        res.locals.user = null;
    }
    next();
});

// Middleware для проверки, заполнено ли имя пользователя (для новых Steam-пользователей)
const checkUsernameCompletion = async (req, res, next) => {
    if (!req.user) {
        console.warn("[checkUsernameCompletion] req.user is undefined despite isAuthenticated() potentially being true. Skipping check.");
        return next();
    }

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

    const isAllowedPath = allowedPaths.some(path => req.path === path || req.path.startsWith(path + '/'));

    if (!req.user.first_name || req.user.first_name.trim().length === 0 ||
        !req.user.last_name || req.user.last_name.trim().length === 0) {

        if (!isAllowedPath) {
            return res.redirect('/complete-profile');
        }
    }
    next();
};
app.use(checkUsernameCompletion);

function checkAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect("/login");
}

app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    async (req, res) => {

        try {
            const steamId64 = req.user.id;
            const steamDisplayName = req.user.displayName;
            const defaultPhotoPath = '/avatars/default_avatar_64.png';
            let currentPilotUuid = null;
            let updates = {};

            const [userRows, pilotRows] = await Promise.all([
                db('users')
                    .select('id', 'steam_id_64', 'pilot_uuid', 'username', 'first_name', 'last_name', 'is_admin', 'PhotoPath')
                    .where('steam_id_64', steamId64),
                db('pilots').select('UUID', 'Name').where('steam_id_64', steamId64)
            ]);

            let userInDb = userRows[0];
            if (pilotRows.length > 0) {
                currentPilotUuid = pilotRows[0].UUID;
            }

            if (!userInDb) {
                const [newUserId] = await db('users').insert({
                    steam_id_64: steamId64,
                    username: steamDisplayName,
                    first_name: '',
                    last_name: '',
                    pilot_uuid: currentPilotUuid,
                    PhotoPath: defaultPhotoPath,
                    registered_at: db.fn.now(),
                    last_login_at: db.fn.now()
                });

                userInDb = {
                    id: newUserId,
                    steam_id_64: steamId64,
                    username: steamDisplayName,
                    first_name: '',
                    last_name: '',
                    pilot_uuid: currentPilotUuid,
                    PhotoPath: defaultPhotoPath,
                    is_admin: 0
                };
                Object.assign(req.user, userInDb);

            } else {
                if (!userInDb.pilot_uuid && currentPilotUuid) {
                    updates.pilot_uuid = currentPilotUuid;
                    userInDb.pilot_uuid = currentPilotUuid;
                }

                if (userInDb.username === '' || userInDb.username === steamId64) {
                    updates.username = steamDisplayName;
                    userInDb.username = steamDisplayName;
                }

                if (!userInDb.PhotoPath || userInDb.PhotoPath.trim() === '') {
                    updates.PhotoPath = defaultPhotoPath;
                    userInDb.PhotoPath = defaultPhotoPath;
                }

                updates.last_login_at = db.fn.now();

                if (Object.keys(updates).length > 0) {
                    await db('users').where('id', userInDb.id).update(updates);
                }
                Object.assign(req.user, userInDb);
            }

            if (!req.user.first_name || req.user.first_name.trim().length === 0 ||
                !req.user.last_name || req.user.last_name.trim().length === 0) {
                return res.redirect('/complete-profile');
            }

            let redirectPath = '/profile';
            if (req.user.pilot_uuid) {
                const pilotName = pilotRows.length > 0 ? pilotRows[0].Name : null;
                if (pilotName) {
                    redirectPath = `/profile/${encodeURIComponent(pilotName)}`;
                } else {
                    console.log(`[auth/steam/return] User ${req.user.id} has pilot_uuid but pilot name not found. Redirecting to /profile.`);
                }
            } else {
                console.log(`[auth/steam/return] User ${req.user.id} is authenticated but not linked to a pilot. Redirecting to /profile.`);
            }

            console.log('Устанавливаю куки для SteamID:', req.user.id, {
                domain: '.onrender.com',
                secure: true,
                sameSite: 'none'
            });

            // res.cookie('session', req.user.id, {
            //     httpOnly: true,
            //     secure: true,
            //     sameSite: 'none',
            //     domain: '.onrender.com.onrender.com',
            //     maxAge: 30 * 24 * 60 * 60 * 1000,
            // });

            return res.redirect(redirectPath);

        } catch (error) {
            return res.redirect('/');
        }
    }
);


app.get('/logout', (req, res, next) => {
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
            res.redirect('/');
        });
    });
});

app.get('/complete-profile', (req, res) => {

    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }

    if (req.user.first_name && req.user.first_name.trim().length > 0 &&
        req.user.last_name && req.user.last_name.trim().length > 0) {
        return res.redirect('/');
    }

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

        await db('users')
            .where('id', userId)
            .update({
                first_name,
                last_name,
                username
            });

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
    try {
        const rows = await db('pilots as p')
            .select(
                'p.Name',
                'p.EloRanking',
                'p.RaceCount',
                'p.UUID',
                'p.AverageChange',
                'u.username',
                'u.YoutubeChannel',
                'u.TwitchChannel'
            )
            .leftJoin('users as u', 'p.steam_id_64', 'u.steam_id_64') // LEFT JOIN по steam_id_64
            .orderBy('p.EloRanking', 'desc');

        res.render("pilots", { pilots: rows, activeMenu: 'pilots' });
    } catch (error) {
        console.error("[Root GET] Error fetching data for / (root):", error);
        res.status(500).send("Error fetching data");
    }
});


app.get("/pilot/:name", async (req, res) => {
    const pilotName = req.params.name;

    try {
        const pilotLookupRows = await db('pilots')
            .select('UUID')
            .where('Name', pilotName);

        if (pilotLookupRows.length === 0) {
            return res.status(404).send("Pilot not found");
        }

        const pilotUUID = pilotLookupRows[0].UUID;

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

app.get("/profile/:username", async (req, res) => {
    const username = req.params.username;

    try {
        const userRows = await db('users')
            .select(
                'id',
                'username',
                'first_name',
                'last_name',
                'DiscordId',
                'YoutubeChannel',
                'TwitchChannel',
                'Instagram',
                'Twitter',
                'iRacingCustomerId',
                'Country',
                'City',
                'PhotoPath',
                'TeamUUID',
                'IsTeamInterested'
            )
            .where({ username })
            .limit(1);

        if (userRows.length === 0) {
            return res.status(404).send("Користувача не знайдено");
        }

        const profileData = userRows[0];

        const teamRows = await db('teams').select('UUID', 'Name');
        const availableTeams = teamRows.map(team => ({
            uuid: team.UUID,
            name: team.Name
        }));

        const isOwnProfile = req.isAuthenticated() && req.user && req.user.id === profileData.id;

        res.render("profile", {
            profileData,
            teams: availableTeams,
            activeMenu: null,
            isAuthenticated: req.isAuthenticated(),
            currentUser: req.user,
            isOwnProfile: isOwnProfile
        });

    } catch (error) {
        console.error("[GET /profile/:username] Error fetching user profile:", error);
        res.status(500).send("Помилка при завантаженні профілю");
    }
});


app.get("/profile", checkAuthenticated, async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect("/login");
    }

    const userId = req.user.id;

    try {
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
                'PhotoPath',
                'TeamUUID',
                'IsTeamInterested',
                'first_name',
                'last_name'
            )
            .where({ id: userId });

        const userProfile = userRows[0] || {};
        const teamRows = await db('teams').select('UUID', 'Name');
        const availableTeams = teamRows.map(team => ({
            uuid: team.UUID,
            name: team.Name
        }));

        res.render("profile", {
            profileData: userProfile,
            teams: availableTeams,
            activeMenu: 'profile',
            isAuthenticated: req.isAuthenticated(),
            currentUser: req.user
        });

    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).send("Error fetching user profile data.");
    }
});


app.post('/profile/update', async (req, res) => {
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
        console.warn(`[profile/update POST] Invalid iRacingCustomerId: ${sanitizedIRacingCustomerId}`);
        return res.status(400).json({ success: false, message: 'Поле "iRacing Customer ID" повинно містити лише цифри.' });
    }

    const latinRegex = /^[a-zA-Z]+$/;
    if (!sanitizedFirstName) {
        console.warn("[profile/update POST] First name is empty.");
        return res.status(400).json({ success: false, message: 'Ім\'я не може бути пустим.' });
    }
    if (!latinRegex.test(sanitizedFirstName)) {
        console.warn(`[profile/update POST] Invalid first name: ${sanitizedFirstName}`);
        return res.status(400).json({ success: false, message: 'Ім\'я повинно містити лише латинські літери.' });
    }
    if (!sanitizedLastName) {
        console.warn("[profile/update POST] Last name is empty.");
        return res.status(400).json({ success: false, message: 'Прізвище не може бути пустим.' });
    }
    if (!latinRegex.test(sanitizedLastName)) {
        console.warn(`[profile/update POST] Invalid last name: ${sanitizedLastName}`);
        return res.status(400).json({ success: false, message: 'Прізвище повинно містити лише латинські літери.' });
    }

    const newUsername = `${sanitizedFirstName} ${sanitizedLastName}`;

    let finalIsTeamInterested = (IsTeamInterested === true || IsTeamInterested === 'on' || IsTeamInterested === 1) ? 1 : 0;
    if (finalTeamUUID) {
        finalIsTeamInterested = 0;
        console.log(`[profile/update POST] TeamUUID is present, setting IsTeamInterested to 0.`);
    } else {
        console.log(`[profile/update POST] TeamUUID is NOT present, IsTeamInterested is: ${finalIsTeamInterested}`);
    }

    try {
        const updateData = {
            first_name: sanitizedFirstName,
            last_name: sanitizedLastName,
            username: newUsername,
            iRacingCustomerId: sanitizedIRacingCustomerId || null,
            LMUName: sanitizedLMUName || null,
            DiscordId: sanitizedDiscordId || null,
            YoutubeChannel: sanitizedYoutubeChannel || null,
            TwitchChannel: sanitizedTwitchChannel || null,
            Instagram: sanitizedInstagram || null,
            Twitter: sanitizedTwitter || null,
            Country: sanitizedCountry || null,
            City: sanitizedCity || null,
            TeamUUID: finalTeamUUID,
            IsTeamInterested: finalIsTeamInterested
        };

        const result = await db('users').where({ id: userId }).update(updateData);

        if (result === 0) {
            console.warn(`[profile/update POST] No rows updated for user ID: ${userId}.`);
            return res.status(404).json({ success: false, message: "Користувач не знайдений або немає змін для збереження" });
        }

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

// app.get("/profile/:pilotName", async (req, res) => {
//     const pilotName = req.params.pilotName;

//     try {
//         const pilot = await db("pilots")
//             .select("Name", "DiscordId", "YoutubeChannel", "TwitchChannel", "Instagram", "Twitter", "iRacingCustomerId", "Country", "City", "PhotoPath", "TeamUUID", "IsTeamInterested")
//             .where({ Name: pilotName })
//             .first();

//         if (!pilot) {
//             return res.status(404).send("Пілот не знайдений");
//         }

//         const teams = await db("teams").select("UUID", "Name").orderBy("Name");

//         // Подставляем значения по умолчанию
//         pilot.PhotoPath = pilot.PhotoPath || '/avatars/default_avatar_64.png';
//         pilot.DiscordId = pilot.DiscordId || '';
//         pilot.YoutubeChannel = pilot.YoutubeChannel || '';
//         pilot.TwitchChannel = pilot.TwitchChannel || '';
//         pilot.Instagram = pilot.Instagram || '';
//         pilot.Twitter = pilot.Twitter || '';
//         pilot.iRacingCustomerId = pilot.iRacingCustomerId || '';
//         pilot.Country = pilot.Country || '';
//         pilot.City = pilot.City || '';
//         pilot.TeamUUID = pilot.TeamUUID || null;
//         pilot.IsTeamInterested = pilot.IsTeamInterested || false;

//         res.render("profile", {
//             profileData: pilot,
//             teams,
//             activeMenu: 'profile',
//             isAuthenticated: req.isAuthenticated(),
//             currentUser: req.user
//         });

//     } catch (error) {
//         console.error("[Public Profile GET] Error fetching public pilot profile:", error);
//         res.status(500).send("Помилка завантаження профілю");
//     }
// });


// app.post("/profile/upload-photo", upload.single('photo'), async (req, res) => {
//     if (!req.isAuthenticated()) {
//         if (req.file) {
//             fs.unlink(req.file.path, (err) => {
//                 if (err) console.error('Error deleting temporary file for unauthenticated user:', err);
//             });
//         }
//         return res.status(403).json({ message: "У вас немає прав для завантаження фото" });
//     }

//     const userId = req.user.id;
//     console.log(`[upload-photo] User ID: ${userId}`);
//     console.log("Received file upload:", req.file);

//     if (!req.file) {
//         return res.status(400).json({ message: "Файл не завантажено" });
//     }

//     try {
//         const user = await db('users')
//             .select('PhotoPath')
//             .where({ id: userId })
//             .first();

//         const oldPhotoPath = user?.PhotoPath;
//         const fileExtension = path.extname(req.file.originalname);
//         const newFilename = `${userId}-${Date.now()}${fileExtension}`;
//         const newPhotoPath = `/avatars/${newFilename}`;
//         const newFilePath = path.join(__dirname, 'public', 'avatars', newFilename);

//         await fs.promises.rename(req.file.path, newFilePath);
//         console.log(`[upload-photo] Renamed temporary file ${req.file.filename} to ${newFilename}`);

//         // Удаляем старое фото (если оно не дефолтное)
//         if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
//             const oldFilePath = path.join(__dirname, 'public', oldPhotoPath);
//             fs.unlink(oldFilePath, (err) => {
//                 if (err) console.error('Error deleting old photo file:', err);
//                 else console.log(`[upload-photo] Deleted old photo: ${oldFilePath}`);
//             });
//         }

//         await db('users')
//             .where({ id: userId })
//             .update({ PhotoPath: newPhotoPath });

//         console.log(`[upload-photo] Database updated with new PhotoPath: ${newPhotoPath}`);

//         req.user.PhotoPath = newPhotoPath;

//         res.status(200).json({
//             message: "Фото успішно завантажено",
//             photoPath: newPhotoPath
//         });

//     } catch (error) {
//         console.error("Error uploading photo:", error);
//         if (req.file) {
//             fs.unlink(req.file.path, (err) => {
//                 if (err) console.error('Error deleting temporary file after processing error:', err);
//             });
//         }
//         res.status(500).json({ message: "Помилка при завантаженні фото", error: error.message });
//     }
// });


// app.delete("/profile/delete-photo", async (req, res) => {
//     if (!req.isAuthenticated()) {
//         return res.status(403).json({ message: "У вас немає прав для видалення фото." });
//     }

//     const userId = req.user.id;

//     try {
//         const user = await db("users")
//             .select("PhotoPath")
//             .where({ id: userId })
//             .first();

//         const oldPhotoPath = user?.PhotoPath;
//         const defaultAvatarPath = "/avatars/default_avatar_64.png";

//         if (oldPhotoPath && oldPhotoPath !== defaultAvatarPath) {
//             const filePath = path.join(__dirname, "public", oldPhotoPath);
//             fs.unlink(filePath, (err) => {
//                 if (err) console.error("Error deleting old photo file:", err);
//                 else console.log(`[delete-photo] Deleted photo file: ${filePath}`);
//             });
//         }

//         await db("users")
//             .where({ id: userId })
//             .update({ PhotoPath: defaultAvatarPath });

//         req.user.PhotoPath = defaultAvatarPath;

//         res.status(200).json({
//             message: "Фото видалено",
//             photoPath: defaultAvatarPath
//         });

//     } catch (error) {
//         console.error("Помилка видалення фото:", error);
//         res.status(500).json({ message: "Помилка видалення фото", error: error.message });
//     }
// });





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

        const topRaceCountPilots = await db("pilots")
            .select("Name", "RaceCount")
            .orderBy("RaceCount", "desc")
            .limit(15);

        const topWinsPilots = await db("pilots")
            .select("Name", "Wins")
            .orderBy("Wins", "desc")
            .limit(15);

        const topPodiumsPilots = await db("pilots")
            .select("Name", "Podiums")
            .orderBy("Podiums", "desc")
            .limit(15);

        const topPolesPilots = await db("trackrecords")
            .select("BestQualifyingLapPilot as Name")
            .count("UUID as PoleCount")
            .whereNotNull("BestQualifyingLapPilot")
            .andWhere("BestQualifyingLapPilot", "!=", "")
            .groupBy("BestQualifyingLapPilot")
            .orderBy("PoleCount", "desc")
            .limit(15);

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
});

// Пинг сервера каждые 14 минут, чтобы не заснул (free plan)
const https = require('https');
const PING_URL = 'https://elo-rating-1.onrender.com/ping';

setInterval(() => {
    https.get(PING_URL, (res) => {
        // success – silent
    }).on('error', (err) => {
        console.error('[Auto-Ping] ❌ Ping failed:', err.message);
    });
}, 1000 * 60 * 14);
