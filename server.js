const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const app = express();
const port = process.env.PORT || 3000;

const dbConfig = {
  host: 'mysql-11416919-suunto-ce35.b.aivencloud.com',
  user: 'avnadmin',
  password: 'AVNS_Ll9dDQhtH0Oh2WmTz4c',
  database: 'defaultdb',
  port: '13693',
};

const pool = mysql.createPool(dbConfig);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

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
            SELECT id, date, description
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
            SELECT id, date, description
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});