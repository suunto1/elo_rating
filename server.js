require('dotenv').config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const geoip = require('geoip-lite');
const app = express();
const port = process.env.PORT || 3000;

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10),
  ssl: {
        rejectUnauthorized: false 
    }
};

console.log('--- Final dbConfig object ---');
console.log(dbConfig); // Выводим весь объект dbConfig
console.log('-----------------------------');

const pool = mysql.createPool(dbConfig);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/", (req, res) => {
    res.redirect("/pilots");
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
            if (!races[row.RaceUUID]) {
                races[row.RaceUUID] = new Set();
                raceDates.push(row.StartDate);
            }
            races[row.RaceUUID].add(row.PilotUUID);
        });

        Object.keys(races).forEach((raceUUID) => {
            const newParticipants = [...races[raceUUID]].filter(
                (pilot) => !allParticipants.has(pilot)
            );
            newParticipantsCount.push(newParticipants.length);
            newParticipants.forEach((pilot) => allParticipants.add(pilot));
            cumulativeParticipantsCount.push(allParticipants.size);
        });

        console.log("Cumulative Participants Count:", cumulativeParticipantsCount);
        console.log("New Participants Count:", newParticipantsCount);
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
        const ip = req.ip || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];
        const pageUrl = req.headers.referer || req.headers.referrer || req.originalUrl;

        let processedIp = ip; 

        if (ip.includes('.')) { 
            const parts = ip.split('.');
            if (parts.length === 4) {
                processedIp = parts[0] + '.' + parts[1] + '.' + parts[2] + '.0';
            }
        } 
        else if (ip.includes(':')) { 
            const parts = ip.split(':');
            if (parts.length > 4) { 
                processedIp = parts.slice(0, 4).join(':') + '::';
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