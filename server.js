const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
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

app.set('view engine', 'ejs'); // Используем шаблонизатор EJS для отображения HTML
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Маршрут для страницы пилотов
app.get('/pilots', async (req, res) => {
    console.log('Received request for /pilots');
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

        console.log('Pilots data:', rows); // Логируем данные для проверки

        // Отправка данных на страницу HTML
        res.render('pilots', { pilots: rows });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data');
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Маршрут для получения данных о конкретном пилоте
app.get('/pilot/:name', async (req, res) => {
    const pilotName = req.params.name;
    let connection;
    try {
        connection = await pool.getConnection();

        console.log(`Fetching race data for pilot: ${pilotName}`);

        let initialEloRanking = 1500;

        // Получение данных о гонках пилота
        const [raceRows] = await connection.execute(
            `SELECT r.StartDate as Date, rp.EloChange 
             FROM raceparticipants rp
             JOIN pilots p ON rp.PilotUUID = p.UUID
             JOIN races r ON rp.RaceUUID = r.UUID
             WHERE p.Name = ?
             ORDER BY r.StartDate`,
            [pilotName]
        );

        console.log('Race data for pilot:', raceRows);

        let cumulativeElo = initialEloRanking;
        const raceData = raceRows.map(race => {
            const date = new Date(race.Date);
            const utcDate = new Date(date.toISOString()); // Преобразование даты в формат UTC
            cumulativeElo += race.EloChange;
            return {
                Date: utcDate.toISOString(), // Сохранение даты в формате ISO
                CumulativeElo: cumulativeElo
            };
        });

        console.log('Cumulative race data:', raceData);

        res.json(raceData);
    } catch (error) {
        console.error('Error fetching pilot data:', error);
        res.status(500).send('Error fetching pilot data');
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Маршрут для страницы с данными о новых участниках
app.get('/new-participants', async (req, res) => {
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
        rows.forEach(row => {
            if (!races[row.RaceUUID]) {
                races[row.RaceUUID] = new Set();
                raceDates.push(row.StartDate); // Добавляем дату гонки
            }
            races[row.RaceUUID].add(row.PilotUUID);
        });

        // Рассчитываем накопительное количество участников и новых участников
        Object.keys(races).forEach(raceUUID => {
            const newParticipants = [...races[raceUUID]].filter(pilot => !allParticipants.has(pilot));
            newParticipantsCount.push(newParticipants.length);
            newParticipants.forEach(pilot => allParticipants.add(pilot));
            cumulativeParticipantsCount.push(allParticipants.size);
        });

        console.log('Cumulative Participants Count:', cumulativeParticipantsCount); // Проверяем данные
        console.log('New Participants Count:', newParticipantsCount); // Проверяем данные

        // Отправка данных на страницу HTML
        res.render('new_participants', { 
            cumulativeParticipantsCount: JSON.stringify(cumulativeParticipantsCount),
            newParticipantsCount: JSON.stringify(newParticipantsCount),
            raceDates: JSON.stringify(raceDates)
        });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data');
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Маршрут для страницы с данными о трассах
app.get('/tracks', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Connected to database');

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

        console.log('Tracks data:', rows); // Логируем данные для проверки

        const tracks = rows.map(row => ({
            TrackName: row.TrackName,
            Image: row.ImagePath,  // Убедитесь, что ImagePath содержит правильные пути к файлам PNG
            BestQualifyingLapTime: row.BestQualifyingLapTime,
            BestQualifyingLapPilot: row.BestQualifyingLapPilot,
            BestRaceLapTime: row.BestRaceLapTime,
            BestRaceLapPilot: row.BestRaceLapPilot
        }));

        console.log('Processed tracks data:', tracks); // Логируем результат обработки данных

        // Отправка данных на страницу HTML
        res.render('tracks', { tracks });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data');
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
