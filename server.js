require('dotenv').config();
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

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

// Multer for file uploads (specifically for avatars)
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
        // Use req.user.id for authenticated uploads, otherwise handle appropriately
        const userId = req.user ? req.user.id : 'unknown';
        const fileExtension = path.extname(file.originalname);
        cb(null, `${userId}-${Date.now()}${fileExtension}`);
    }
});
const upload = multer({ storage: storage });

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 60,
    queueLimit: 1000
};

const pool = mysql.createPool(dbConfig);

// --- Steam and Session Configuration ---
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
    let connection;
    try {
        connection = await pool.getConnection();
        // Ensure all relevant user fields are selected here for req.user object
        const [rows] = await connection.execute(
            `SELECT id, username, PhotoPath, LMUName, DiscordId, YoutubeChannel, TwitchChannel, Instagram, Twitter, iRacingCustomerId, Country, City, TeamUUID, IsTeamInterested, steam_id_64, first_name, last_name, pilot_uuid, is_admin
             FROM users WHERE id = ?`,
            [id]
        );
        const user = rows[0];

        if (!user) {
            console.warn("[Passport] deserializeUser - User not found for ID:", id);
            return done(null, false);
        }

        console.log("[Passport] deserializeUser - Successfully deserialized user:", user.username, "ID:", user.id, "Steam ID:", user.steam_id_64);
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
            connection = await pool.getConnection();

            const [userRows] = await connection.execute(
                `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin FROM users WHERE steam_id_64 = ?`,
                [steamId64]
            );
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

                // Only update username if it's empty or still the default steamId64
                if (user.username === '' || user.username === String(steamId64)) {
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
                    is_admin: user.is_admin,
                    PhotoPath: user.PhotoPath // Ensure PhotoPath is passed to req.user
                });
            } else {
                console.log("[SteamStrategy] New Steam user. Creating new entry in `users` table.");

                const [insertResult] = await connection.execute(
                    `INSERT INTO users (steam_id_64, username, first_name, last_name, pilot_uuid, last_login_at, PhotoPath) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
                    [steamId64, steamDisplayName, '', '', pilotUuidToLink, '/avatars/default_avatar_64.png'] // Set default avatar for new users
                );
                const newUserId = insertResult.insertId;

                const [newUserRows] = await connection.execute(
                    `SELECT id, steam_id_64, pilot_uuid, username, first_name, last_name, is_admin, PhotoPath FROM users WHERE id = ?`,
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

// Configure MySQL Session Store
const sessionStore = new MySQLStore({}, pool);

app.set('trust proxy', 1);

// Configure Sessions
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        secure: true, // Requires HTTPS
        sameSite: 'none', // Required for cross-site cookies (e.g., Vercel frontend, backend API)
        maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
    }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware to add user information to res.locals for EJS
app.use((req, res, next) => {
    console.log("[Session Check] Cookie headers:", req.headers.cookie);
    console.log("[Session Check] Session ID:", req.sessionID);
    console.log("[Session Check] Session:", req.session);

    if (req.isAuthenticated() && req.user) {
        // If first_name and last_name are filled, use them for username
        if (req.user.first_name && req.user.first_name.trim().length > 0 &&
            req.user.last_name && req.user.last_name.trim().length > 0) {
            res.locals.user = {
                ...req.user,
                username: `${req.user.first_name.trim()} ${req.user.last_name.trim()}`
            };
        } else {
            // If first_name/last_name are not filled, use username from DB (Steam Display Name)
            // Ensure username is always a string
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

// Middleware to check if username is completed (for new Steam users)
const checkUsernameCompletion = async (req, res, next) => {
    console.log(`[checkUsernameCompletion] Path: ${req.path}`);
    console.log(`[checkUsernameCompletion] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[checkUsernameCompletion] req.user (at start of middleware):`, req.user);

    // Additional check to avoid error if req.user is indeed undefined
    if (!req.user) {
        console.warn("[checkUsernameCompletion] req.user is undefined despite isAuthenticated() potentially being true. Skipping check.");
        return next();
    }

    // Define paths that do not require a complete profile for access
    const allowedPaths = [
        '/complete-profile',
        '/auth/steam',
        '/auth/steam/return',
        '/logout',
        '/api/events',
        '/track-view',
        '/api/search-pilots', // Allow search without full profile
        '/teams', // Allow team views without full profile
        '/team/', // Allow individual team views
        '/events', // Allow event views
        '/event/', // Allow individual event views
        '/race/', // Allow individual race views
        '/login', // Allow login page
        '/rules', // Allow rules page
        '/contacts', // Allow contacts page
        '/privacy-policy', // Allow privacy policy
        '/tracks', // Allow tracks page
        '/api/tracks', // Allow tracks API
        '/new-participants', // Allow analytics page
        '/analytics', // Allow analytics page
        '/' // Allow root/pilots listing page
    ];

    // Check if the current path is in the list of allowed paths
    const isAllowedPath = allowedPaths.some(path => req.path.startsWith(path))
        || /^\/profile(\/.*)?$/.test(req.path) // Allow all /profile and /profile/:pilotName
        || /^\/pilot(\/.*)?$/.test(req.path); // Allow all /pilot and /pilot/:pilotName

    // If user is authenticated, but first_name OR last_name are not filled
    if (req.isAuthenticated() && (!req.user.first_name || req.user.first_name.trim().length === 0 ||
        !req.user.last_name || req.user.last_name.trim().length === 0)) {

        // If the user tries to access any page other than the allowed ones
        if (!isAllowedPath) {
            console.log(`[checkUsernameCompletion] Redirecting user ${req.user.id} to /complete-profile as first_name or last_name is missing.`);
            // Redirect to a clean /complete-profile, without parameters
            return res.redirect('/complete-profile');
        }
    }
    next(); // Continue request execution
};
app.use(checkUsernameCompletion);

function checkAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect("/login");
}

// --- Steam Authentication Routes ---

app.get('/auth/steam',
    passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    async (req, res) => {
        console.log(`[auth/steam/return] Successful authentication. req.user:`, req.user);

        // Redirect logic to ensure profile completion or send to relevant profile
        if (!req.user.first_name || req.user.first_name.trim().length === 0 ||
            !req.user.last_name || req.user.last_name.trim().length === 0) {
            console.log(`[auth/steam/return] User ${req.user.id} needs to complete profile. Redirecting to /complete-profile.`);
            return res.redirect('/complete-profile');
        }

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
                    console.log(`[auth/steam/return] User ${req.user.id} (Pilot ${pilotName}) redirected to /profile/${encodeURIComponent(pilotName)}`);
                    return res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
                }
            } catch (error) {
                console.error("[auth/steam/return] Error redirecting to pilot profile after Steam auth:", error);
            } finally {
                if (connection) connection.release();
            }
        }

        console.log(`[auth/steam/return] User ${req.user.id} is authenticated but not linked to a pilot or pilot name not found. Redirecting to /profile.`);
        return res.redirect('/profile');
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

// --- Routes for completing first/last name (only for new users) ---
app.get('/complete-profile', (req, res) => {
    console.log(`[complete-profile GET] Path: ${req.path}`);
    console.log(`[complete-profile GET] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[complete-profile GET] req.user:`, req.user);
    console.log("req.session:", req.session);

    // If user is not authenticated, redirect to homepage
    if (!req.isAuthenticated()) {
        console.log(`[complete-profile GET] User not authenticated. Redirecting to /.`);
        return res.redirect('/');
    }

    // If user is authenticated AND their first AND last name are ALREADY FILLED, redirect to homepage
    // Use .trim().length > 0 for reliable check against empty strings
    if (req.user.first_name && req.user.first_name.trim().length > 0 &&
        req.user.last_name && req.user.last_name.trim().length > 0) {
        console.log(`[complete-profile GET] User ${req.user.id} already completed profile. Redirecting to /.`);
        // If profile is complete, redirect them to their specific pilot profile if linked
        if (req.user.pilot_uuid && req.user.username) { // Assuming username would be pilot name here
            return res.redirect(`/profile/${encodeURIComponent(req.user.username)}`);
        }
        return res.redirect('/'); // Fallback to homepage
    }

    // Otherwise, render the profile completion page
    res.render('complete_profile', {
        message: null,
        messageType: null,
        activeMenu: 'complete-profile',
        first_name: req.user.first_name || '',
        last_name: req.user.last_name || ''
    });
});

app.post("/complete-profile", checkAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const { first_name, last_name } = req.body;
        const userId = req.user.id;
        const username = `${first_name.trim()} ${last_name.trim()}`; // Ensure trimmed username

        await connection.execute(
            "UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE id = ?",
            [first_name.trim(), last_name.trim(), username, userId]
        );

        // Update req.user object in the session immediately
        req.user.first_name = first_name.trim();
        req.user.last_name = last_name.trim();
        req.user.username = username; // Update username as well

        req.session.save(async (err) => {
            if (err) {
                console.error("Error saving session after profile update:", err);
                return res.status(500).render("complete_profile", { message: "Помилка збереження сесії. Спробуйте ще раз.", messageType: "danger" });
            }

            let pilotName = null;
            if (req.user.pilot_uuid) {
                const [rows] = await connection.execute(
                    "SELECT Name FROM pilots WHERE UUID = ?",
                    [req.user.pilot_uuid]
                );
                if (rows.length > 0) {
                    pilotName = rows[0].Name;
                }
            }

            if (pilotName) {
                res.redirect(`/profile/${encodeURIComponent(pilotName)}`);
            } else {
                res.redirect("/profile");
            }
        });

    } catch (error) {
        console.error("Error completing profile:", error);
        res.status(500).render("complete_profile", { message: "Помилка збереження даних. Спробуйте ще раз.", messageType: "danger" });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/", async (req, res) => {
    console.log(`[Root GET] Path: ${req.path}`);
    console.log(`[Root GET] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[Root GET] req.user:`, req.user);

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
        console.error("[Root GET] Error fetching data for / (root):", error);
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
        console.log(`[Pilot Profile GET] Fetching data for pilot: ${pilotName}`);

        const [pilotLookupRows] = await connection.execute(
            `SELECT UUID FROM pilots WHERE Name = ?`,
            [pilotName]
        );

        if (pilotLookupRows.length === 0) {
            console.warn(`[Pilot Profile GET] Pilot with name ${pilotName} not found.`);
            return res.status(404).send("Pilot not found");
        }
        const pilotUUID = pilotLookupRows[0].UUID;

        let initialEloRanking = 1500;
        const [eloRaceRows] = await connection.execute(
            `SELECT r.StartDate as Date, rp.EloChange
             FROM raceparticipants rp
             JOIN pilots p ON rp.PilotUUID = p.UUID
             JOIN races r ON rp.RaceUUID = r.UUID
             WHERE p.UUID = ?
             ORDER BY r.StartDate`,
            [pilotUUID]
        );

        let cumulativeElo = initialEloRanking;
        const eloChartData = eloRaceRows.map((race) => {
            const date = new Date(race.Date);
            const utcDate = new Date(date.toISOString()); // Ensure UTC
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
            WHERE UUID = ?`,
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
        console.error("[Pilot Profile GET] Error fetching pilot data:", error);
        res.status(500).send("Error fetching pilot data");
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

app.get("/profile", async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect("/login");
    }

    const userId = req.user.id;

    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.execute(
            `SELECT LMUName, DiscordId, YoutubeChannel, TwitchChannel,
            Instagram, Twitter, iRacingCustomerId, Country, City,
            TeamUUID, IsTeamInterested, PhotoPath
            FROM users WHERE id = ?`,
            [userId]
        );

        if (rows.length === 0) {
            return res.render("profile", {
                userProfile: {},
                availableTeams: [],
                activeMenu: 'profile',
                isAuthenticated: req.isAuthenticated(),
                user: req.user
            });
        }

        const userProfile = rows[0];
        const [teams] = await connection.execute(`SELECT UUID, Name FROM teams`);
        const availableTeams = teams.map(team => ({
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
    } finally {
        if (connection) connection.release();
    }
});

app.post('/profile/update', async (req, res) => {
    console.log(`[profile/update POST] Path: ${req.path}`);
    console.log(`[profile/update POST] isAuthenticated(): ${req.isAuthenticated()}`);
    console.log(`[profile/update POST] req.user:`, req.user);
    console.log(`[profile/update POST] req.body:`, req.body); // Added log for incoming data

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
        IsTeamInterested // This will be a boolean value from the frontend
    } = req.body;

    // Sanitize input data using DOMPurify
    const sanitizedIRacingCustomerId = DOMPurify.sanitize(iRacingCustomerId || '').trim();
    const sanitizedLMUName = DOMPurify.sanitize(LMUName || '').trim();
    const sanitizedDiscordId = DOMPurify.sanitize(DiscordId || '').trim();
    const sanitizedYoutubeChannel = DOMPurify.sanitize(YoutubeChannel || '').trim();
    const sanitizedTwitchChannel = DOMPurify.sanitize(TwitchChannel || '').trim();
    const sanitizedInstagram = DOMPurify.sanitize(Instagram || '').trim();
    const sanitizedTwitter = DOMPurify.sanitize(Twitter || '').trim();
    const sanitizedCountry = DOMPurify.sanitize(Country || '').trim();
    const sanitizedCity = DOMPurify.sanitize(City || '').trim();

    // ADJUSTMENT HERE: Check TeamUUID before sanitization and assignment
    const finalTeamUUID = (TeamUUID === '' || TeamUUID === undefined || TeamUUID === null) ? null : DOMPurify.sanitize(TeamUUID).trim();

    // Server-side validation for iRacingCustomerId
    if (sanitizedIRacingCustomerId && !/^[0-9]+$/.test(sanitizedIRacingCustomerId)) {
        console.warn(`[profile/update POST] Invalid iRacingCustomerId: ${sanitizedIRacingCustomerId}`);
        return res.status(400).json({ success: false, message: 'Поле "iRacing Customer ID" повинно містити лише цифри.' });
    }

    // Logic for IsTeamInterested: if TeamUUID is selected, IsTeamInterested should be false
    let finalIsTeamInterested = (IsTeamInterested === true || IsTeamInterested === 'on' || IsTeamInterested === 1) ? 1 : 0;
    if (finalTeamUUID) { // Use finalTeamUUID
        finalIsTeamInterested = 0; // If a team is present, interest in joining a team is removed
        console.log(`[profile/update POST] TeamUUID is present, setting IsTeamInterested to 0.`);
    } else {
        console.log(`[profile/update POST] TeamUUID is NOT present, IsTeamInterested is: ${finalIsTeamInterested}`);
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const updateFields = [];
        const updateValues = [];

        updateFields.push('iRacingCustomerId = ?'); updateValues.push(sanitizedIRacingCustomerId);
        updateFields.push('LMUName = ?'); updateValues.push(sanitizedLMUName);
        updateFields.push('DiscordId = ?'); updateValues.push(sanitizedDiscordId);
        updateFields.push('YoutubeChannel = ?'); updateValues.push(sanitizedYoutubeChannel);
        updateFields.push('TwitchChannel = ?'); updateValues.push(sanitizedTwitchChannel);
        updateFields.push('Instagram = ?'); updateValues.push(sanitizedInstagram);
        updateFields.push('Twitter = ?'); updateValues.push(sanitizedTwitter);
        updateFields.push('Country = ?'); updateValues.push(sanitizedCountry);
        updateFields.push('City = ?'); updateValues.push(sanitizedCity);
        updateFields.push('TeamUUID = ?'); updateValues.push(finalTeamUUID); // Use finalTeamUUID
        updateFields.push('IsTeamInterested = ?'); updateValues.push(finalIsTeamInterested);

        const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
        updateValues.push(userId);

        console.log("[profile/update POST] Executing update query:", query, "with values:", updateValues);
        const [result] = await connection.execute(query, updateValues);

        if (result.affectedRows === 0) {
            console.warn(`[profile/update POST] No rows updated for user ID: ${userId}. User might not exist or no changes were made.`);
            return res.status(404).json({ success: false, message: "Користувач не знайдений або немає змін для збереження." });
        }

        // Update req.user object in the current session
        req.user.iRacingCustomerId = sanitizedIRacingCustomerId;
        req.user.LMUName = sanitizedLMUName;
        req.user.DiscordId = sanitizedDiscordId;
        req.user.YoutubeChannel = sanitizedYoutubeChannel;
        req.user.TwitchChannel = sanitizedTwitchChannel;
        req.user.Instagram = sanitizedInstagram;
        req.user.Twitter = sanitizedTwitter;
        req.user.Country = sanitizedCountry;
        req.user.City = sanitizedCity;
        req.user.TeamUUID = finalTeamUUID; // Update with finalTeamUUID
        req.user.IsTeamInterested = finalIsTeamInterested;

        // Explicitly save the session
        req.session.save((err) => {
            if (err) {
                console.error("[profile/update POST] Error saving session:", err);
                return res.status(500).json({ success: false, message: "Помилка збереження сесії." });
            }
            console.log(`[profile/update POST] User ${userId} profile updated successfully and session saved.`);
            res.json({ success: true, message: "Профіль успішно оновлено!" });
        });

    } catch (error) {
        console.error("[profile/update POST] Error updating user profile:", error);
        res.status(500).json({ success: false, message: "Помилка сервера при оновленні профілю." });
    } finally {
        if (connection) connection.release();
    }
});

app.post("/profile/upload-photo", upload.single('photo'), async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(403).json({ message: "У вас немає прав для завантаження фото." });
    }

    const userId = req.user.id;

    console.log("Received file upload:", req.file);

    if (!req.file) {
        return res.status(400).json({ message: "Файл не завантажено" });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const photoPath = '/avatars/' + req.file.filename;

        const [rows] = await connection.execute(`SELECT PhotoPath FROM users WHERE id = ?`, [userId]);
        const oldPhotoPath = rows[0]?.PhotoPath;
        // Check if oldPhotoPath exists and is not the default avatar before attempting to delete
        if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
            const filePath = path.join(__dirname, 'public', oldPhotoPath);
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting old photo file:', err);
            });
        }

        await connection.execute(
            `UPDATE users SET PhotoPath = ? WHERE id = ?`,
            [photoPath, userId]
        );

        // Update req.user in session immediately
        req.user.PhotoPath = photoPath;

        res.status(200).json({ message: "Фото успішно завантажено", photoPath: photoPath });
    } catch (error) {
        console.error("Error uploading photo:", error);
        // If an error occurred, delete the uploaded file to prevent "orphan" files
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error(`Error deleting uploaded file on error: ${req.file.path}`, err);
            });
        }
        res.status(500).json({ message: "Помилка при завантаженні фото" });
    } finally {
        if (connection) connection.release();
    }
});

app.delete("/profile/delete-photo", async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(403).json({ message: "У вас немає прав для видалення фото." });
    }

    const userId = req.user.id;

    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.execute(`SELECT PhotoPath FROM users WHERE id = ?`, [userId]);
        const oldPhotoPath = rows[0]?.PhotoPath;

        if (oldPhotoPath && oldPhotoPath !== '/avatars/default_avatar_64.png') {
            const filePath = path.join(__dirname, 'public', oldPhotoPath);
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting old photo file:', err);
            });
        }

        const defaultAvatarPath = '/avatars/default_avatar_64.png';

        await connection.execute(
            `UPDATE users SET PhotoPath = ? WHERE id = ?`,
            [defaultAvatarPath, userId]
        );

        // Update req.user in session immediately
        req.user.PhotoPath = defaultAvatarPath;

        res.status(200).json({ message: "Фото видалено", photoPath: defaultAvatarPath });
    } catch (error) {
        console.error("Помилка видалення фото:", error);
        res.status(500).json({ message: "Помилка видалення фото" });
    } finally {
        if (connection) connection.release();
    }
});

app.get("/profile/:pilotName", async (req, res) => {
    const pilotName = req.params.pilotName;
    let connection;
    try {
        connection = await pool.getConnection();
        // Fetch user data from 'users' table, not 'pilots' for public profile
        const [pilotUserRows] = await connection.execute(
            `SELECT u.LMUName, u.DiscordId, u.YoutubeChannel, u.TwitchChannel, u.Instagram, u.Twitter, u.iRacingCustomerId, u.Country, u.City, u.PhotoPath, u.TeamUUID, u.IsTeamInterested, p.Name AS PilotName
             FROM users u
             JOIN pilots p ON u.pilot_uuid = p.UUID
             WHERE p.Name = ?`,
            [pilotName]
        );

        let pilot = pilotUserRows[0];
        if (!pilot) {
            console.warn(`[Public Profile GET] Public pilot profile for ${pilotName} not found.`);
            return res.status(404).render("error", { message: "Пилот не найден", activeMenu: null }); // Render an error page
        }

        const [teamsRows] = await connection.execute(`SELECT UUID, Name FROM teams ORDER BY Name`);
        const teams = teamsRows;

        // Ensure fields are not null for rendering
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
        pilot.IsTeamInterested = pilot.IsTeamInterested || false; // Ensure it's a boolean

        res.render("profile", { pilot: pilot, teams: teams, activeMenu: 'profile', isAuthenticated: req.isAuthenticated(), user: req.user });
    } catch (error) {
        console.error("[Public Profile GET] Error fetching public pilot profile:", error);
        res.status(500).render("error", { message: "Помилка завантаження профілю", activeMenu: null }); // Render an error page
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
            const date = new Date(row.StartDate).toISOString().split('T')[0]; // Use YYYY-MM-DD
            if (!races[date]) {
                races[date] = new Set();
                raceDates.push(date);
            }
            races[date].add(row.PilotUUID);
        });

        raceDates.sort(); // Ensure dates are sorted for correct cumulative counting

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
            SELECT UUID, Name, Description, EventStartDate, EventEndDate, PhotoPath
            FROM events
            ORDER BY EventStartDate
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
        // Assuming your 'events' table has 'EventStartDate', 'Name' (for description), 'UUID' (for URL)
        const [rows] = await connection.execute(`
            SELECT UUID as id, EventStartDate as date, Name as description, CONCAT('/event/', UUID) as url
            FROM events
            ORDER BY EventStartDate
        `);
        console.log("Events data for calendar:", rows);
        res.render("calendar", { events: rows, activeMenu: 'calendar' });
    } catch (error) {
        console.error("Error fetching data for calendar:", error);
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
        // Use req.originalUrl to get the actual path requested by the client
        // req.headers.referer/referrer might be unreliable or not always present
        const pageUrl = req.originalUrl;

        let processedIp = ip;

        // Anonymize IPv4
        if (ip && ip.includes('.') && ip.split('.').length === 4) {
            const parts = ip.split('.');
            processedIp = parts[0] + '.' + parts[1] + '.' + parts[2] + '.0';
        }
        // Anonymize IPv6 (simplistic for example, might need more robust solution)
        else if (ip && ip.includes(':')) {
            const parts = ip.split(':');
            // Keep first 3 blocks for general location, then anonymize
            if (parts.length > 3) {
                processedIp = parts.slice(0, 3).join(':') + '::';
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

// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Open http://localhost:${port}`);
});