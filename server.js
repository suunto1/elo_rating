const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const app = express();
const port = process.env.PORT || 3000;

// Настройки подключения к базе данных MySQL
const dbConfig = {
    host: 'mysql-11416919-suunto-ce35.b.aivencloud.com',
    user: 'avnadmin',
    password: 'AVNS_Ll9dDQhtH0Oh2WmTz4c',
    database: 'defaultdb',
    port: '13693'
};

const pool = mysql.createPool(dbConfig);

app.set("view engine", "ejs"); // Используем шаблонизатор EJS для отображения HTML
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/pilots");
});

// Маршрут для страницы пилотов
app.get("/pilots", async (req, res) => {
  console.log("Received request for /pilots");
  let connection;
  try {
    connection = await pool.getConnection();
    // Выполнение запроса к базе данных для получения информации о пилотах
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
    console.log("Pilots data:", rows); // Логируем данные для проверки
    // Отправка данных на страницу HTML
    res.render("pilots", { pilots: rows });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).send("Error fetching data");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Маршрут для получения данных о конкретном пилоте
app.get("/pilot/:name", async (req, res) => {
  const pilotName = req.params.name;
  let connection;
  try {
    connection = await pool.getConnection();
    console.log(`Fetching data for pilot: ${pilotName}`);

    // Получение данных ELO для графика
    let initialEloRanking = 1500; // Базовое значение ELO, если нет предыдущих записей
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

    // --- Измененный запрос для статистики пилота ---
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
    }; // Устанавливаем значения по умолчанию, если пилот не найден

    res.json({
      eloChartData: eloChartData,
      stats: {
        starts: pilotStats.RaceCount,
        wins: pilotStats.Wins,
        podiums: pilotStats.Podiums,
        top5: pilotStats.Top5,
        top10: pilotStats.Top10,
        podiumRate: pilotStats.PodiumPercentage, // Уже процент, просто передаем
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

// Маршрут для страницы с данными о новых участниках
app.get("/new-participants", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    // Получение всех участников гонок
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
    // Определяем участников для каждой гонки
    rows.forEach((row) => {
      if (!races[row.RaceUUID]) {
        races[row.RaceUUID] = new Set();
        raceDates.push(row.StartDate); // Добавляем дату гонки
      }
      races[row.RaceUUID].add(row.PilotUUID);
    });
    // Рассчитываем накопительное количество участников и новых участников
    Object.keys(races).forEach((raceUUID) => {
      const newParticipants = [...races[raceUUID]].filter(
        (pilot) => !allParticipants.has(pilot)
      );
      newParticipantsCount.push(newParticipants.length);
      newParticipants.forEach((pilot) => allParticipants.add(pilot));
      cumulativeParticipantsCount.push(allParticipants.size);
    });
    console.log("Cumulative Participants Count:", cumulativeParticipantsCount); // Проверяем данные
    console.log("New Participants Count:", newParticipantsCount); // Проверяем данные
    // Отправка данных на страницу HTML
    res.render("new_participants", {
      cumulativeParticipantsCount: JSON.stringify(cumulativeParticipantsCount),
      newParticipantsCount: JSON.stringify(newParticipantsCount),
      raceDates: JSON.stringify(raceDates),
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

// Маршрут для страницы с данными о трассах
app.get("/tracks", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log("Connected to database");
    // Выполнение запроса к базе данных для получения информации о трассах и путях к изображениям
    const [rows] = await connection.execute(`
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
    console.log("Tracks data:", rows); // Логируем данные для проверки
    const tracks = rows.map((row) => ({
      TrackName: row.TrackName,
      Image: row.ImagePath, // Убедитесь, что ImagePath содержит правильные пути к файлам PNG
      BestQualifyingLapTime: row.BestQualifyingLapTime,
      BestQualifyingLapPilot: row.BestQualifyingLapPilot,
      BestRaceLapTime: row.BestRaceLapTime,
      BestRaceLapPilot: row.BestRaceLapPilot,
    }));
    console.log("Processed tracks data:", tracks); // Логируем результат обработки данных
    // Отправка данных на страницу HTML
    res.render("tracks", { tracks });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).send("Error fetching data");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

//Маршрут для получения всех событий через API
// для динамического добавления данных о событиях через клиентский JavaScript
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

// Маршрут для отображения страницы календаря:
app.get("/calendar", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    // Получение всех событий из базы данных
    const [rows] = await connection.execute(`
            SELECT id, date, description
            FROM events
            ORDER BY date
        `);
    console.log("Events data:", rows); // Логируем данные для проверки
    // Отправка данных на страницу HTML
    res.render("calendar", { events: rows });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).send("Error fetching data");
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});