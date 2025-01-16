const mysql = require('mysql2/promise');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// Функция для чтения данных из XLSX файлов
function readXlsxFiles(folderPath) {
    const files = fs.readdirSync(folderPath).filter(file => path.extname(file) === '.xlsx');
    console.log('Files found:', files);
    return files.map(file => {
        const filePath = path.join(folderPath, file);
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        console.log(`Data from ${file}:`, data);
        return data;
    });
}

// Функция для преобразования даты из формата Excel в формат YYYY-MM-DD
function convertDate(date) {
    if (!date) {
        console.error('Invalid date:', date);
        return null;
    }
    if (typeof date === 'number') {
        const excelStartDate = new Date(Date.UTC(1899, 11, 30));
        const resultDate = new Date(excelStartDate.getTime() + date * 86400000); // 86400000 = количество миллисекунд в одном дне
        const formattedDate = resultDate.toISOString().split('T')[0];
        console.log('Converted date:', formattedDate);
        return formattedDate;
    } else if (typeof date === 'string') {
        const [month, day, year] = date.split('/');
        const formattedDate = `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        console.log('Converted date:', formattedDate);
        return formattedDate;
    }
    console.error('Invalid date format:', date);
    return null;
}

// Функция для проверки и сохранения времени в нужном формате
function formatLapTime(lapTime) {
    if (!lapTime || (typeof lapTime === 'string' && lapTime.trim() === '')) {
        return null;
    }
    if (typeof lapTime === 'number') {
        const minutes = Math.floor(lapTime / 60);
        const seconds = (lapTime % 60).toFixed(4).padStart(7, '0');
        return `${minutes}:${seconds}`;
    }
    return lapTime; // Вернуть как есть, если это строка в формате mm:ss.SSSS
}

// Функция для расчета нового значения ELO
function calculateNewElo(currentElo, k, actual, expected) {
    return currentElo + k * (actual - expected);
}

// Функция для выполнения запросов к базе данных
async function executeQuery(connection, query, params) {
    try {
        console.log('Executing query:', query, params);
        const cleanParams = params.map(param => param === undefined ? null : param);
        const [rows] = await connection.execute(query, cleanParams);
        console.log('Query result:', rows);
        return rows;
    } catch (error) {
        console.error('Error executing query:', error);
        throw error;
    }
}

// Функция для определения коэффициента K с учетом сплита
function determineK(participants, split) {
    let baseK;
    if (participants <= 10) {
        baseK = 20; // Минимальное значение при 10 и менее участниках
    } else {
        baseK = 20 + ((participants - 10) / 10) * 30; // Линейная интерполяция с увеличением на 30 за каждые 10 участников
    }

    return split === 1 ? baseK : baseK * 0.75; // Для сплита 2 коэффициент уменьшен
}


// Функция для добавления новой гонки и получения её UUID
async function addNewRace(connection, newRace, competitionUUID) {
    console.log('Debug newRace:', newRace);

    if (!newRace.TrackName?.trim() || !String(newRace.StartDate)?.trim() || !newRace.Class?.trim()) {
        throw new Error('Ошибка: Название трассы, дата или класс не должны быть пустыми.');
    }

    const existingRaceQuery = `
        SELECT 1 FROM Races 
        WHERE TrackName = ? AND StartDate = ? AND CompetitionUUID = ? AND Class = ? AND Split = ?`;
    const existingRaceParams = [newRace.TrackName, newRace.StartDate, competitionUUID, newRace.Class, newRace.Split];

    if ((await executeQuery(connection, existingRaceQuery, existingRaceParams)).length > 0) {
        throw new Error(`Ошибка: Гонка с названием ${newRace.TrackName} для класса ${newRace.Class} и сплита ${newRace.Split} уже существует.`);
    }

    const insertRaceQuery = `
        INSERT INTO Races (UUID, TrackName, StartDate, CompetitionUUID, Class, Split, BestQualifyingLapTime, BestQualifyingLapPilot, BestRaceLapTime, BestRaceLapPilot) 
        VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertRaceParams = [
        newRace.TrackName || null, 
        newRace.StartDate || null, 
        competitionUUID || null, 
        newRace.Class || null, 
        newRace.Split || null, 
        newRace.BestQualifyingLapTime !== null ? formatLapTime(newRace.BestQualifyingLapTime) : null,
        newRace.BestQualifyingLapPilot || null,
        newRace.BestRaceLapTime !== null ? formatLapTime(newRace.BestRaceLapTime) : null,
        newRace.BestRaceLapPilot || null
    ];
    await executeQuery(connection, insertRaceQuery, insertRaceParams);

    const raceUUIDQuery = `
        SELECT UUID FROM Races 
        WHERE TrackName = ? AND StartDate = ? AND CompetitionUUID = ? AND Class = ? AND Split = ?`;
    const raceUUIDParams = [newRace.TrackName, newRace.StartDate, competitionUUID, newRace.Class, newRace.Split];
    const raceRows = await executeQuery(connection, raceUUIDQuery, raceUUIDParams);

    if (raceRows.length === 0) {
        throw new Error('Ошибка при добавлении новой гонки.');
    }

    console.log(`Добавлена новая гонка: ${newRace.TrackName} для класса ${newRace.Class} и сплита ${newRace.Split}`);
    return raceRows[0].UUID;
}

// Функция для получения или создания пилота
async function getOrCreatePilot(connection, pilotName) {
    console.log('Checking pilot:', pilotName);
    const selectPilotQuery = 'SELECT UUID, RaceCount FROM Pilots WHERE Name = ?';
    const pilotRows = await executeQuery(connection, selectPilotQuery, [pilotName]);

    let pilotUUID;
    if (pilotRows.length > 0) {
        pilotUUID = pilotRows[0].UUID;
    } else {
        console.log('Adding new pilot:', pilotName);
        const insertPilotQuery = 'INSERT INTO Pilots (UUID, Name, EloRanking, RaceCount) VALUES (UUID(), ?, ?, 0)';
        await executeQuery(connection, insertPilotQuery, [pilotName, 1500]);

        const newPilotRows = await executeQuery(connection, selectPilotQuery, [pilotName]);
        pilotUUID = newPilotRows[0].UUID;
        console.log(`Добавлен новый пилот: ${pilotName}`);
    }

    console.log('Pilot UUID:', pilotUUID);
    return pilotUUID;
}

// Функция для проверки существования пилота в гонке
async function checkExistingPilot(connection, raceUUID, competitionUUID, pilotUUID) {
    const checkExistingPilotQuery = `
        SELECT 1 FROM RaceParticipants 
        WHERE RaceUUID = ? AND CompetitionUUID = ? AND PilotUUID = ?`;
    const checkExistingPilotParams = [raceUUID, competitionUUID, pilotUUID];
    const existingPilot = await executeQuery(connection, checkExistingPilotQuery, checkExistingPilotParams);
    return existingPilot.length > 0;
}

// Функция для преобразования времени круга из формата mm:ss.SSSS в строку
function convertLapTimeToString(lapTime) {
    if (!lapTime || (typeof lapTime === 'string' && lapTime.trim() === '')) {
        return null;
    }
    if (typeof lapTime === 'string') {
        return lapTime;
    }
    const minutes = Math.floor(lapTime / 60);
    const seconds = Math.floor(lapTime % 60);
    const milliseconds = (lapTime % 1).toFixed(4).substring(2);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${milliseconds}`;
}

// Функция для вставки участника гонки
async function insertRaceParticipant(connection, competitionUUID, raceUUID, pilotUUID, place) {
    const insertRaceParticipantQuery = `
        INSERT INTO RaceParticipants (UUID, CompetitionUUID, RaceUUID, PilotUUID, Place) 
        VALUES (UUID(), ?, ?, ?, ?)`;
    await executeQuery(connection, insertRaceParticipantQuery, [competitionUUID, raceUUID, pilotUUID, place]);
	console.log(`Inserted participant: ${pilotUUID} in race: ${raceUUID} with place: ${place}`);
}

// Функция для обновления количества гонок у пилота
async function updatePilotRaceCount(connection, pilotUUID) {
    const updatePilotRaceCountQuery = 'UPDATE Pilots SET RaceCount = RaceCount + 1 WHERE UUID = ?';
    await executeQuery(connection, updatePilotRaceCountQuery, [pilotUUID]);
}

// Функция для обновления ELO рейтингов с учетом сплита и расчета среднего изменения
async function updateEloRankings(connection, raceUUID, split) {
    const raceParticipantsQuery = 'SELECT PilotUUID, Place FROM RaceParticipants WHERE RaceUUID = ?';
    const rows = await executeQuery(connection, raceParticipantsQuery, [raceUUID]);

    if (rows.length === 0) {
        console.log('Нет данных для обработки.');
        return;
    }

    const participants = rows.length; // Определяем количество участников
    const K = determineK(participants, split); // Определяем коэффициент K

    const pilotUUIDs = rows.map(row => row.PilotUUID);
    const placeholders = pilotUUIDs.map(() => '?').join(', ');
    const pilotsQuery = `SELECT UUID, Name, EloRanking FROM Pilots WHERE UUID IN (${placeholders})`;
    const eloRows = await executeQuery(connection, pilotsQuery, pilotUUIDs);

    if (eloRows.length === 0) {
        console.log('Нет данных о пилотах.');
        return;
    }

    const avgElo = eloRows.reduce((sum, pilot) => sum + pilot.EloRanking, 0) / eloRows.length;

    for (let row of rows) {
        const pilot = eloRows.find(p => p.UUID === row.PilotUUID);
        if (!pilot) {
            console.log(`Пилот с UUID ${row.PilotUUID} не найден.`);
            continue;
        }
        const expected = 1 / (1 + Math.pow(10, (avgElo - pilot.EloRanking) / 400));
        const actual = 1 - (row.Place - 1) / (rows.length - 1);
        const newElo = calculateNewElo(pilot.EloRanking, K, actual, expected);

        const eloChange = newElo - pilot.EloRanking;
        const updatePilotEloQuery = 'UPDATE Pilots SET EloRanking = ? WHERE UUID = ?';
        await executeQuery(connection, updatePilotEloQuery, [newElo, pilot.UUID]);

        const updateRaceParticipantsQuery = 'UPDATE RaceParticipants SET EloChange = ?, EloAtRace = ? WHERE PilotUUID = ? AND RaceUUID = ?';
        await executeQuery(connection, updateRaceParticipantsQuery, [eloChange, pilot.EloRanking, pilot.UUID, raceUUID]);

        console.log(`Обновлен ELO рейтинг для пилота: ${pilot.Name}, Новый ELO: ${newElo}, Изменение ELO: ${eloChange}`);
    }

    // Обновление среднего изменения ELO для каждого пилота
    for (let pilot of eloRows) {
        const averageChangeQuery = `
            SELECT AVG(EloChange) as AverageChange
            FROM RaceParticipants
            WHERE PilotUUID = ?`;
        const averageChangeResult = await executeQuery(connection, averageChangeQuery, [pilot.UUID]);
        const averageChange = averageChangeResult[0].AverageChange;

        const updateAverageChangeQuery = 'UPDATE Pilots SET AverageChange = ? WHERE UUID = ?';
        await executeQuery(connection, updateAverageChangeQuery, [averageChange, pilot.UUID]);

        console.log(`Обновлено среднее изменение ELO для пилота: ${pilot.Name}, Среднее изменение ELO: ${averageChange}`);
    }

    console.log('Elo ratings updated successfully!');
}


//Функция для добавления результатов гонок с учетом сплита
async function addRaceResultsForClass(connection, raceUUID, raceResults, competitionUUID, split) {
    console.log('Starting addRaceResultsForClass');
    console.log('Race UUID:', raceUUID);
    console.log('Competition UUID:', competitionUUID);
    console.log('Split:', split);
    console.log('Race Results:', raceResults);

    if (raceResults.length === 0) {
        console.log('No race results found.');
        return;
    }

    const placesSet = new Set();
    for (let result of raceResults) {
        if (result.Place === 'Place' && result.PilotName === 'Pilot Name') {
            continue;
        }

        console.log('Processing result:', result);


    }

    for (let result of raceResults) {
        console.log('Adding pilot:', result.PilotName);
        const pilotUUID = await getOrCreatePilot(connection, result.PilotName);

        const isExistingPilotInRace = await checkExistingPilot(connection, raceUUID, competitionUUID, pilotUUID);

        if (!isExistingPilotInRace) {
            await insertRaceParticipant(connection, competitionUUID, raceUUID, pilotUUID, result.Place);
            await updatePilotRaceCount(connection, pilotUUID);

            console.log(`Добавлены результаты гонки для пилота: ${result.PilotName}, Место: ${result.Place}`);
        } else {
            console.log(`Пилот ${result.PilotName} уже участвует в гонке.`);
        }
    }

    console.log('Race results added successfully!');
    await updateEloRankings(connection, raceUUID, split);
}

// Основная функция добавления результатов гонок
async function addRaceResults() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: 'SQLsuunto',
        database: 'elo_ranking',
        multipleStatements: true
    });

    const folderPath = './xlsx_files'; // Путь к папке с xlsx файлами
    const filesData = readXlsxFiles(folderPath);

    try {
        await connection.beginTransaction();

        for (const fileData of filesData) {
            console.log('Processing file data:', fileData);

            if (!Array.isArray(fileData) || fileData.length === 0) {
                console.error('Invalid file data:', fileData);
                continue;
            }
            const headers = fileData[0];
            if (!Array.isArray(headers) || headers.length === 0) {
                console.error('Invalid headers:', headers);
                continue;
            }

            const competitionName = fileData[1]?.[headers.indexOf('Competition Name')]?.trim() || null;
            const trackName = fileData[1]?.[headers.indexOf('Track Name')]?.trim() || null;
            const startDate = convertDate(fileData[1]?.[headers.indexOf('Start Date')] || '');
            const raceClass = fileData[1]?.[headers.indexOf('Class')]?.trim() || null;
            const split = parseInt(fileData[1]?.[headers.indexOf('Split')], 10) || null;
            const bestQualifyingLapTime = fileData[1]?.[headers.indexOf('Best Qualifying Lap Time')] || null;
            const bestQualifyingLapPilot = fileData[1]?.[headers.indexOf('Best Qualifying Lap Pilot')] || null;
            const bestRaceLapTime = fileData[1]?.[headers.indexOf('Best Race Lap Time')] || null;
            const bestRaceLapPilot = fileData[1]?.[headers.indexOf('Best Race Lap Pilot')] || null;

            console.log('Data to process:', {
                competitionName, 
                trackName, 
                startDate, 
                raceClass, 
                split,
                bestQualifyingLapTime,
                bestQualifyingLapPilot,
                bestRaceLapTime,
                bestRaceLapPilot,                
                fileData: fileData.slice(1)
            });

            if (!competitionName || !trackName || !startDate || !raceClass || isNaN(split)) {
                console.error('Ошибка: Одно или несколько обязательных полей пусты.');
                continue; // Пропускаем итерацию, если одно из обязательных полей пусто
            }

            const raceResults = fileData.slice(1).map(row => ({
                Place: row[headers.indexOf('Place')],
                PilotName: row[headers.indexOf('Pilot Name')],
                PilotUUID: null
            })).filter(result => result.Place && result.PilotName);

            console.log('Filtered race results:', raceResults);

            // Проверка на дубли пилотов
            const pilotNamesSet = new Set();
            for (const result of raceResults) {
                if (pilotNamesSet.has(result.PilotName)) {
                    console.error(`Ошибка: Дубли пилота найдены в результатах гонки. Дублирующийся пилот: ${result.PilotName}. Гонка: ${competitionName}, ${trackName}, ${startDate}, Класс: ${raceClass}, Сплит: ${split}`);
                    await connection.rollback();
                    return; // Остановить вставку всех данных и выйти из функции
                }
                pilotNamesSet.add(result.PilotName);
            }

            for (const result of raceResults) {
                const pilotUUID = await getOrCreatePilot(connection, result.PilotName);
                result.PilotUUID = pilotUUID;
            }
            
            console.log('Filtered race results with UUIDs:', raceResults);

            let competitionUUID = (await executeQuery(connection,
                'SELECT UUID FROM Competitions WHERE Name = ?', [competitionName]))[0]?.UUID;

            console.log('Competition UUID:', competitionUUID);

            if (!competitionUUID) {
                await executeQuery(connection,
                    'INSERT INTO Competitions (UUID, Name) VALUES (UUID(), ?)', [competitionName]);

                const newCompetitionRows = await executeQuery(connection,
                    'SELECT UUID FROM Competitions WHERE Name = ?', [competitionName]);

                if (newCompetitionRows.length === 0) {
                    throw new Error('Ошибка при добавлении нового соревнования.');
                }

                competitionUUID = newCompetitionRows[0].UUID;
                console.log(`Добавлено новое соревнование: ${competitionName}`);
            } else {
                console.log(`Соревнование ${competitionName} уже существует. Добавление новых гонок в это соревнование.`);
            }

            const newRace = {
                TrackName: trackName,
                StartDate: startDate,
                Class: raceClass,
                Split: split,
                BestQualifyingLapTime: convertLapTimeToString(bestQualifyingLapTime),
                BestQualifyingLapPilot: bestQualifyingLapPilot,
                BestRaceLapTime: convertLapTimeToString(bestRaceLapTime),
                BestRaceLapPilot: bestRaceLapPilot
            };

            const raceUUID = await addNewRace(connection, newRace, competitionUUID);

            console.log('Race UUID:', raceUUID);

            await addRaceResultsForClass(connection, raceUUID, raceResults, competitionUUID, split);

            // Обновление лучшего времени на круге для трассы
            const baseTrackName = trackName.replace(/\s*\(.*\)$/, '').trim(); // Удаляем суффиксы
            const [existingTrack] = await connection.execute(`
                SELECT * FROM TrackRecords WHERE TrackName = ?
            `, [baseTrackName]);

            if (existingTrack.length === 0) {
                // Вставляем новое время круга, если трассы еще нет в базе
                await connection.execute(`
                    INSERT INTO TrackRecords (TrackName, BestQualifyingLapTime, BestQualifyingLapPilot, BestRaceLapTime, BestRaceLapPilot)
                    VALUES (?, ?, ?, ?, ?)
                `, [baseTrackName, bestQualifyingLapTime, bestQualifyingLapPilot, bestRaceLapTime, bestRaceLapPilot]);
            } else {
                // Обновляем время круга, если оно улучшилось
                const updateQueries = [];
                if (bestQualifyingLapTime && (!existingTrack[0].BestQualifyingLapTime || bestQualifyingLapTime < existingTrack[0].BestQualifyingLapTime)) {
                    updateQueries.push(connection.execute(`
                        UPDATE TrackRecords SET BestQualifyingLapTime = ?, BestQualifyingLapPilot = ? WHERE TrackName = ?
                    `, [bestQualifyingLapTime, bestQualifyingLapPilot, baseTrackName]));
                }
                if (bestRaceLapTime && (!existingTrack[0].BestRaceLapTime || bestRaceLapTime < existingTrack[0].BestRaceLapTime)) {
                    updateQueries.push(connection.execute(`
                        UPDATE TrackRecords SET BestRaceLapTime = ?, BestRaceLapPilot = ? WHERE TrackName = ?
                    `, [bestRaceLapTime, bestRaceLapPilot, baseTrackName]));
                }
                await Promise.all(updateQueries);
            }
        }

        await connection.commit();
        console.log('Все данные успешно добавлены в базу данных.');
    } catch (error) {
        console.error('Error adding race results, rolling back:', error);
        await connection.rollback();
    } finally {
        await connection.end();
    }
}


addRaceResults();

