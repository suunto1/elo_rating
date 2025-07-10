const mysql = require("mysql2/promise");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require('uuid');

const dbConfig = {
  host: "localhost",
  user: "root",
  password: "SQLsuunto",
  database: "elo_ranking",
};
const INITIAL_ELO = 1500; // Начальный ELO рейтинг для новых пилотов

async function executeQuery(connection, sql, params) {
  try {
    const [rows] = await connection.execute(sql, params);
    return rows;
  } catch (error) {
    console.error("Ошибка выполнения запроса:", sql, params, error);
    throw error;
  }
}
function readXlsxFiles(folderPath) {
  const filesData = [];
  const files = fs.readdirSync(folderPath);
  files.forEach((file) => {
    if (file.endsWith(".xlsx")) {
      const filePath = path.join(folderPath, file);
      console.log(`Reading file: ${filePath}`);
      try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
        filesData.push(jsonData);
      } catch (error) {
        console.error(`Error reading file ${file}:`, error);
      }
    }
  });
  return filesData;
}
function convertDate(excelDate) {
  if (typeof excelDate === "number") {
    // Excel date is days since 1900-01-01 (or 1904 for Mac). Assuming 1900.
    // Subtract 25569 to convert to JavaScript date epoch (January 1, 1970).
    // Multiply by 86400000 (milliseconds in a day)
    const date = new Date((excelDate - 25569) * 86400000);
    return date.toISOString().split("T")[0]; // Format as YYYY-MM-DD
  }
  return excelDate; // Assume it's already in a readable date format if not a number
}
function convertLapTimeToString(lapTime) {
  if (typeof lapTime === "number") {
    const totalSeconds = lapTime * 24 * 60 * 60; // Convert from Excel's fraction of a day to seconds
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.round(
      (totalSeconds - Math.floor(totalSeconds)) * 1000
    );
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
  }
  return lapTime; // If it's already a string, return as is
}
async function getOrCreatePilot(connection, pilotName) {
  const [rows] = await connection.execute(
    "SELECT UUID FROM Pilots WHERE Name = ?",
    [pilotName]
  );
  if (rows.length > 0) {
    return rows[0].UUID;
  } else {
    const newPilotUUID = (
      await executeQuery(
        connection,
        "INSERT INTO Pilots (UUID, Name, EloRanking, RaceCount, AverageChange, Wins, Podiums, Top5, Top10, PodiumPercentage) VALUES (UUID(), ?, ?, 0, 0, 0, 0, 0, 0, 0)",
        [pilotName, INITIAL_ELO]
      )
    )[0]?.insertId;
    // После вставки, снова выбрать UUID, так как insertId не возвращает UUID
    const [newRows] = await connection.execute(
      "SELECT UUID FROM Pilots WHERE Name = ?",
      [pilotName]
    );
    if (newRows.length > 0) {
      console.log(
        `Добавлен новый пилот: ${pilotName} с начальным ELO: ${INITIAL_ELO}`
      );
      return newRows[0].UUID;
    } else {
      throw new Error(`Failed to retrieve UUID for new pilot: ${pilotName}`);
    }
  }
}
async function checkExistingPilot(
  connection,
  raceUUID,
  competitionUUID,
  pilotUUID
) {
  const [rows] = await connection.execute(
    "SELECT COUNT(*) AS count FROM RaceParticipants WHERE RaceUUID = ? AND CompetitionUUID = ? AND PilotUUID = ?",
    [raceUUID, competitionUUID, pilotUUID]
  );
  return rows[0].count > 0;
}
async function insertRaceParticipant(
  connection,
  competitionUUID,
  raceUUID,
  pilotUUID,
  place
) {
  await executeQuery(
    connection,
    "INSERT INTO RaceParticipants (UUID, CompetitionUUID, RaceUUID, PilotUUID, Place, EloAtRace, EloChange) VALUES (UUID(), ?, ?, ?, ?, ?, ?)",
    [competitionUUID, raceUUID, pilotUUID, place, INITIAL_ELO, 0] // Начальное EloAtRace и EloChange = 0, они будут обновлены позже
  );
}

async function addNewRace(connection, newRace, competitionUUID) {
  // Эта проверка на существование гонки по параметрам остается.
  // Если гонка с такими же параметрами уже есть, мы ее не добавляем снова.
  const existingRaceQueryCheck = `
        SELECT UUID FROM Races
        WHERE TrackName = ? AND StartDate = ? AND Class = ? AND Split = ? AND CompetitionUUID = ?`;

  // --- ЛОГ 1: Что мы ищем перед INSERT ---
  console.log(`[addNewRace] Проверяем существующую гонку с параметрами:
        Трек: '${newRace.TrackName}'
        Дата: '${newRace.StartDate}'
        Класс: '${newRace.Class}'
        Сплит: ${newRace.Split}
        Соревнование UUID: '${competitionUUID}'`
  );

  const [existingRace] = await connection.execute(existingRaceQueryCheck, [
    newRace.TrackName,
    newRace.StartDate,
    newRace.Class,
    newRace.Split,
    competitionUUID,
  ]);

  if (existingRace.length > 0) {
    // --- ЛОГ 2: Если гонка уже найдена ---
    console.log(`[addNewRace] Гонка ${newRace.TrackName} (${newRace.Class}, Split ${newRace.Split}) на ${newRace.StartDate} уже существует. UUID: ${existingRace[0].UUID}`);
    return existingRace[0].UUID; // Возвращаем UUID уже существующей гонки
  }

  // Если гонка не найдена, переходим к вставке
  console.log("[addNewRace] Гонка не найдена в базе данных. Попытка вставить новую гонку.");

  // --- ЛОГ 3: Данные для вставки ---
  console.log("[addNewRace] Данные, которые будут вставлены:", {
    competitionUUID: competitionUUID,
    TrackName: newRace.TrackName,
    StartDate: newRace.StartDate,
    Class: newRace.Class,
    Split: newRace.Split,
    BestQualifyingLapTime: newRace.BestQualifyingLapTime,
    BestQualifyingLapPilot: newRace.BestQualifyingLapPilot,
    BestRaceLapTime: newRace.BestRaceLapTime,
    BestRaceLapPilot: newRace.BestRaceLapPilot,
  });

  // *** ГЕНЕРИРУЕМ UUID В NODE.JS ***
  const generatedRaceUUID = uuidv4();
  console.log(`[addNewRace] Генерируем новый UUID для гонки: ${generatedRaceUUID}`);

  const insertRaceQuery = `
        INSERT INTO Races (UUID, CompetitionUUID, TrackName, StartDate, Class, Split, BestQualifyingLapTime, BestQualifyingLapPilot, BestRaceLapTime, BestRaceLapPilot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
  try {
    const [insertResult] = await connection.execute(insertRaceQuery, [
      generatedRaceUUID, // Используем сгенерированный UUID
      competitionUUID,
      newRace.TrackName,
      newRace.StartDate,
      newRace.Class,
      newRace.Split,
      newRace.BestQualifyingLapTime,
      newRace.BestQualifyingLapPilot,
      newRace.BestRaceLapTime,
      newRace.BestRaceLapPilot,
    ]);
    // ЛОГ: Проверяем результат INSERT
    console.log("[addNewRace] Результат INSERT:", insertResult); // Это покажет affectedRows, insertId и т.д.
    console.log("[addNewRace] Запрос INSERT для новой гонки выполнен успешно.");
  } catch (insertError) {
    console.error(`[addNewRace] ОШИБКА при выполнении INSERT запроса: ${insertError.message}`);
    throw new Error(`Ошибка при вставке новой гонки: ${insertError.message}`);
  }

  // После успешной вставки, мы уже знаем UUID, так что не нужно делать повторный SELECT.
  console.log(`Добавлена новая гонка: ${newRace.TrackName} для класса ${newRace.Class} и сплита ${newRace.Split}`);
  return generatedRaceUUID; // Возвращаем только что сгенерированный UUID
}

function determineK(participants, split) {
  if (split === 1) {
    // Pro
    if (participants >= 10) return 32;
    if (participants >= 5) return 24;
    return 16;
  } else if (split === 2) {
    // Am
    if (participants >= 10) return 24;
    if (participants >= 5) return 16;
    return 8;
  }
  return 16; // Default K-factor
}
function calculateNewElo(currentElo, K, actualScore, expectedScore) {
  return currentElo + K * (actualScore - expectedScore);
}
// =================================================================================================
// ФУНКЦИЯ: updatePilotStatistics (обновлена для использования EloAtRace)
// =================================================================================================
// Функция для обновления статистики пилота (победы, подиумы, топ-5, топ-10, процент подиумов)
async function updatePilotStatistics(connection, pilotUUID) {
  // Получаем все гонки для пилота, чтобы рассчитать статистику
  const [pilotRaces] = await connection.execute(
    `SELECT rp.Place
          FROM RaceParticipants rp
          WHERE rp.PilotUUID = ?`,
    [pilotUUID]
  );
  let wins = 0;
  let podiums = 0; // 1-е, 2-е, 3-е места
  let top5 = 0;
  let top10 = 0;
  const raceCount = pilotRaces.length; // Обновленное RaceCount
  pilotRaces.forEach((race) => {
    const place = parseInt(race.Place, 10);
    if (isNaN(place)) return; // Пропускаем, если место не является действительным числом
    if (place === 1) {
      wins++;
    }
    if (place >= 1 && place <= 3) {
      podiums++;
    }
    if (place >= 1 && place <= 5) {
      top5++;
    }
    if (place >= 1 && place <= 10) {
      top10++;
    }
  });
  const podiumPercentage = raceCount > 0 ? (podiums / raceCount) * 100 : 0;
  const updateStatsQuery = `
        UPDATE Pilots
        SET Wins = ?, Podiums = ?, Top5 = ?, Top10 = ?, PodiumPercentage = ?, RaceCount = ?
        WHERE UUID = ?`;
  await executeQuery(connection, updateStatsQuery, [
    wins,
    podiums,
    top5,
    top10,
    podiumPercentage.toFixed(2),
    raceCount,
    pilotUUID,
  ]);
  console.log(
    `Обновлена статистика для пилота ${pilotUUID}: Победы=${wins}, Подиумы=${podiums}, Топ-5=${top5}, Топ-10=${top10}, Процент подиумов=${podiumPercentage.toFixed(
      2
    )}, Стартов=${raceCount}`
  );
}
// =================================================================================================
// КОНЕЦ ФУНКЦИИ: updatePilotStatistics
// =================================================================================================
// Функция для обновления ELO рейтингов с учетом сплита и расчета среднего изменения
async function updateEloRankings(connection, raceUUID, split) {
  const raceParticipantsQuery =
    "SELECT PilotUUID, Place FROM RaceParticipants WHERE RaceUUID = ?";
  const rows = await executeQuery(connection, raceParticipantsQuery, [
    raceUUID,
  ]);
  if (rows.length === 0) {
    console.log("Нет данных для обработки.");
    return;
  }
  const participants = rows.length; // Определяем количество участников
  const K = determineK(participants, split); // Определяем коэффициент K
  const pilotUUIDs = rows.map((row) => row.PilotUUID);
  const placeholders = pilotUUIDs.map(() => "?").join(", ");
  const pilotsQuery = `SELECT UUID, Name, EloRanking FROM Pilots WHERE UUID IN (${placeholders})`;
  const eloRows = await executeQuery(connection, pilotsQuery, pilotUUIDs);
  if (eloRows.length === 0) {
    console.log("Нет данных о пилотах.");
    return;
  }
  const avgElo =
    eloRows.reduce((sum, pilot) => sum + pilot.EloRanking, 0) / eloRows.length;
  for (let row of rows) {
    const pilot = eloRows.find((p) => p.UUID === row.PilotUUID);
    if (!pilot) {
      console.log(`Пилот с UUID ${row.PilotUUID} не найден.`);
      continue;
    }
    // Запоминаем текущий ELO пилота перед расчетом нового ELO для RaceParticipants
    const eloAtRace = pilot.EloRanking;
    const expected = 1 / (1 + Math.pow(10, (avgElo - pilot.EloRanking) / 400));
    const actual = 1 - (row.Place - 1) / (rows.length - 1);
    const newElo = calculateNewElo(pilot.EloRanking, K, actual, expected);
    const eloChange = newElo - pilot.EloRanking;
    const updatePilotEloQuery =
      "UPDATE Pilots SET EloRanking = ? WHERE UUID = ?";
    await executeQuery(connection, updatePilotEloQuery, [newElo, pilot.UUID]);
    // Обновляем EloAtRace и EloChange для записи в RaceParticipants
    const updateRaceParticipantsQuery =
      "UPDATE RaceParticipants SET EloChange = ?, EloAtRace = ? WHERE PilotUUID = ? AND RaceUUID = ?";
    await executeQuery(connection, updateRaceParticipantsQuery, [
      eloChange,
      eloAtRace,
      pilot.UUID,
      raceUUID,
    ]);
    console.log(
      `Обновлен ELO рейтинг для пилота: ${pilot.Name
      }, Новый ELO: ${newElo.toFixed(2)}, Изменение ELO: ${eloChange.toFixed(
        2
      )}`
    );
  }
  // Обновление среднего изменения ELO для каждого пилота
  for (let pilot of eloRows) {
    const averageChangeQuery = `
          SELECT AVG(EloChange) as AverageChange
          FROM RaceParticipants
          WHERE PilotUUID = ?`;
    const averageChangeResult = await executeQuery(
        connection,
        averageChangeQuery,
        [pilot.UUID]
    );

    let averageChange;
    if (averageChangeResult && averageChangeResult.length > 0 && averageChangeResult[0].AverageChange !== undefined) {
        // Пробуем преобразовать к числу, если оно не null
        averageChange = parseFloat(averageChangeResult[0].AverageChange);
        if (isNaN(averageChange)) {
            averageChange = 0; // Если преобразование не удалось, устанавливаем 0
        }
    } else {
        averageChange = 0; // Если результатов нет или они undefined
    }
    
    const updateAverageChangeQuery =
        "UPDATE Pilots SET AverageChange = ? WHERE UUID = ?";
    await executeQuery(connection, updateAverageChangeQuery, [
        averageChange,
        pilot.UUID,
    ]);
    console.log(
        `Обновлено среднее изменение ELO для пилота: ${pilot.Name
        }, Среднее изменение ELO: ${averageChange.toFixed(2)}`
    );
  }
  console.log("Elo ratings updated successfully!");
}
//Функция для добавления результатов гонок с учетом сплита
async function addRaceResultsForClass(
  connection,
  raceUUID,
  raceResults,
  competitionUUID,
  split
) {
  console.log("Starting addRaceResultsForClass");
  console.log("Race UUID:", raceUUID);
  console.log("Competition UUID:", competitionUUID);
  console.log("Split:", split);
  console.log("Race Results:", raceResults);
  if (raceResults.length === 0) {
    console.log("No race results found.");
    return;
  }
  const pilotsInThisRaceUUIDs = []; // Собираем UUIDs пилотов, участвующих в текущей гонке
  for (let result of raceResults) {
    if (result.Place === "Place" && result.PilotName === "Pilot Name") {
      continue;
    }
    console.log("Processing result:", result);
  }
  for (let result of raceResults) {
    console.log("Adding pilot:", result.PilotName);
    const pilotUUID = await getOrCreatePilot(connection, result.PilotName);
    result.PilotUUID = pilotUUID; // Убедимся, что UUID записан в объекте результата
    pilotsInThisRaceUUIDs.push(pilotUUID); // Добавляем UUID в список для инкрементального обновления
    const isExistingPilotInRace = await checkExistingPilot(
      connection,
      raceUUID,
      competitionUUID,
      pilotUUID
    );
    if (!isExistingPilotInRace) {
      await insertRaceParticipant(
        connection,
        competitionUUID,
        raceUUID,
        pilotUUID,
        result.Place
      );
      console.log(
        `Добавлены результаты гонки для пилота: ${result.PilotName}, Место: ${result.Place}`
      );
    } else {
      console.log(`Пилот ${result.PilotName} уже участвует в гонке.`);
    }
  }
  console.log("Race results added successfully!");
  await updateEloRankings(connection, raceUUID, split);

  for (const pilotUUID of pilotsInThisRaceUUIDs) {
    await updatePilotStatistics(connection, pilotUUID);
  }

}

async function calculateAllPilotsStatistics() {
  const connection = await mysql.createConnection(dbConfig);
  try {
    await connection.beginTransaction();
    console.log("Запуск полного пересчета статистики для всех пилотов...");
    const [allPilots] = await connection.execute("SELECT UUID FROM Pilots");
    if (allPilots.length === 0) {
      console.log("В базе данных нет пилотов для обновления статистики.");
      await connection.commit();
      return;
    }
    for (const pilot of allPilots) {
      await updatePilotStatistics(connection, pilot.UUID);
    }
    await connection.commit();
    console.log(
      "Полный пересчет статистики для всех пилотов успешно завершен."
    );
  } catch (error) {
    console.error(
      "Ошибка при полном пересчете статистики, откат транзакции:",
      error
    );
    await connection.rollback();
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}


async function addRaceResults() {
  const connection = await mysql.createConnection(dbConfig);
  const folderPath = "./xlsx_files_new"; // Путь к папке с xlsx файлами
  const filesData = readXlsxFiles(folderPath);
  try {
    await connection.beginTransaction();
    for (const fileData of filesData) {
      console.log("Processing file data:", fileData);
      if (!Array.isArray(fileData) || fileData.length === 0) {
        console.error("Invalid file data:", fileData);
        continue;
      }
      const headers = fileData[0];
      if (!Array.isArray(headers) || headers.length === 0) {
        console.error("Invalid headers:", headers);
        continue;
      }
      const competitionName =
        fileData[1]?.[headers.indexOf("Competition Name")]?.trim() || null;
      const trackName =
        fileData[1]?.[headers.indexOf("Track Name")]?.trim() || null;
      const startDate = convertDate(
        fileData[1]?.[headers.indexOf("Start Date")] || ""
      );
      const raceClass = fileData[1]?.[headers.indexOf("Class")]?.trim() || null;
      const split = parseFloat(fileData[1]?.[headers.indexOf("Split")]) || null;
      const bestQualifyingLapTime =
        fileData[1]?.[headers.indexOf("Best Qualifying Lap Time")] || null;
      const bestQualifyingLapPilot =
        fileData[1]?.[headers.indexOf("Best Qualifying Lap Pilot")] || null;
      const bestRaceLapTime =
        fileData[1]?.[headers.indexOf("Best Race Lap Time")] || null;
      const bestRaceLapPilot =
        fileData[1]?.[headers.indexOf("Best Race Lap Pilot")] || null;
      console.log("Data to process:", {
        competitionName,
        trackName,
        startDate,
        raceClass,
        split,
        bestQualifyingLapTime,
        bestQualifyingLapPilot,
        bestRaceLapTime,
        bestRaceLapPilot,
        fileData: fileData.slice(1),
      });
      if (
        !competitionName ||
        !trackName ||
        !startDate ||
        !raceClass ||
        isNaN(split)
      ) {
        console.error("Ошибка: Одно или несколько обязательных полей пусты.");
        await connection.rollback(); // Откатываем транзакцию при ошибке
        continue; // Продолжаем обрабатывать следующий файл
      }
      const raceResults = fileData
        .slice(1)
        .map((row) => ({
          Place: row[headers.indexOf("Place")],
          PilotName: row[headers.indexOf("Pilot Name")],
          PilotUUID: null,
        }))
        .filter((result) => result.Place && result.PilotName);
      console.log("Filtered race results:", raceResults);
      // Проверка на дубли пилотов
      const pilotNamesSet = new Set();
      for (const result of raceResults) {
        if (pilotNamesSet.has(result.PilotName)) {
          console.error(
            `Ошибка: Дубли пилота найдены в результатах гонки. Дублирующийся пилот: ${result.PilotName}. Гонка: ${competitionName}, ${trackName}, ${startDate}, Класс: ${raceClass}, Сплит: ${split}`
          );
          await connection.rollback();
          throw new Error(`Дубли пилота найдены в файле: ${competitionName}, ${trackName}, ${startDate}`); // Пробрасываем ошибку, чтобы остановить процесс
        }
        pilotNamesSet.add(result.PilotName);
      }
      for (const result of raceResults) {
        const pilotUUID = await getOrCreatePilot(connection, result.PilotName);
        result.PilotUUID = pilotUUID;
      }
      console.log("Filtered race results with UUIDs:", raceResults);
      let competitionUUID = (
        await executeQuery(
          connection,
          "SELECT UUID FROM Competitions WHERE Name = ?",
          [competitionName]
        )
      )[0]?.UUID;
      console.log("Competition UUID:", competitionUUID);
      if (!competitionUUID) {
        await executeQuery(
          connection,
          "INSERT INTO Competitions (UUID, Name) VALUES (UUID(), ?)",
          [competitionName]
        );
        const newCompetitionRows = await executeQuery(
          connection,
          "SELECT UUID FROM Competitions WHERE Name = ?",
          [competitionName]
        );
        if (newCompetitionRows.length === 0) {
          throw new Error("Ошибка при добавлении нового соревнования.");
        }
        competitionUUID = newCompetitionRows[0].UUID;
        console.log(`Добавлено новое соревнование: ${competitionName}`);
      } else {
        console.log(
          `Соревнование ${competitionName} уже существует. Добавление новых гонок в это соревнование.`
        );
      }
      const newRace = {
        TrackName: trackName,
        StartDate: startDate,
        Class: raceClass,
        Split: split,
        BestQualifyingLapTime: convertLapTimeToString(bestQualifyingLapTime),
        BestQualifyingLapPilot: bestQualifyingLapPilot,
        BestRaceLapTime: convertLapTimeToString(bestRaceLapTime),
        BestRaceLapPilot: bestRaceLapPilot,
      };
      const raceUUID = await addNewRace(connection, newRace, competitionUUID);
      console.log("Race UUID:", raceUUID);
      await addRaceResultsForClass(
        connection,
        raceUUID,
        raceResults,
        competitionUUID,
        split
      );
      // Обновление лучшего времени на круге для трассы
      const baseTrackName = trackName.replace(/\s*\(.*\)$/, "").trim(); // Удаляем суффиксы
      const [existingTrack] = await connection.execute(
        `
            SELECT * FROM TrackRecords WHERE TrackName = ?
          `,
        [baseTrackName]
      );
      if (existingTrack.length === 0) {
        // Вставляем новое время круга, если трассы еще нет в базе
        await connection.execute(
          `
              INSERT INTO TrackRecords (TrackName, BestQualifyingLapTime, BestQualifyingLapPilot, BestRaceLapTime, BestRaceLapPilot)
              VALUES (?, ?, ?, ?, ?)
            `,
          [
            baseTrackName,
            bestQualifyingLapTime,
            bestQualifyingLapPilot,
            bestRaceLapTime,
            bestRaceLapPilot,
          ]
        );
      } else {
        // Обновляем время круга, если оно улучшилось
        const updateQueries = [];
        if (
          bestQualifyingLapTime &&
          (!existingTrack[0].BestQualifyingLapTime ||
            bestQualifyingLapTime < existingTrack[0].BestQualifyingLapTime)
        ) {
          updateQueries.push(
            connection.execute(
              `
                  UPDATE TrackRecords SET BestQualifyingLapTime = ?, BestQualifyingLapPilot = ? WHERE TrackName = ?
                `,
              [bestQualifyingLapTime, bestQualifyingLapPilot, baseTrackName]
            )
          );
        }
        if (
          bestRaceLapTime &&
          (!existingTrack[0].BestRaceLapTime ||
            existingTrack[0].BestRaceLapTime === null ||
            bestRaceLapTime < existingTrack[0].BestRaceLapTime)
        ) {
          updateQueries.push(
            connection.execute(
              `
                  UPDATE TrackRecords SET BestRaceLapTime = ?, BestRaceLapPilot = ? WHERE TrackName = ?
                `,
              [bestRaceLapTime, bestRaceLapPilot, baseTrackName]
            )
          );
        }
        await Promise.all(updateQueries);
      }
    }
    await connection.commit();
    console.log("Все данные успешно добавлены в базу данных.");
  } catch (error) {
    console.error("Error adding race results, rolling back:", error);
    await connection.rollback();
    throw error; // Пробрасываем ошибку, чтобы вызывающая функция могла ее поймать
  } finally {
    if (connection) {
      await connection.end(); // Прямое соединение закрываем через end()
    }
  }
}
// =================================================================================================
// НОВАЯ ФУНКЦИЯ: processAllData
// =================================================================================================
async function processAllData() {
  try {
    console.log("Запуск процесса: Сначала добавление результатов гонок...");
    await addRaceResults(); // Сначала запускаем addRaceResults
    console.log("Добавление результатов гонок завершено. Запуск полного пересчета статистики пилотов...");
    await calculateAllPilotsStatistics(); // Затем запускаем calculateAllPilotsStatistics
    console.log("Все операции успешно завершены.");
  } catch (error) {
    console.error("Произошла ошибка во время обработки данных:", error);
  }
}

// =================================================================================================
// КАК ЗАПУСКАТЬ:
//
// 1. Для одноразового полного пересчета всей статистики для всех пилотов:
//     Запустите в командной строке:
//     node updateEloRatings.js calculateAll
//
// 2. Для стандартного обновления данных из XLSX-файлов и полного пересчета статистики:
//     Запустите в командной строке:
//     node updateEloRatings.js processAll
//
//     ИЛИ, если запуск без аргументов, по умолчанию будет processAll
//     node updateEloRatings.js
// =================================================================================================
const operation = process.argv[2]; // Получаем третий аргумент командной строки

if (operation === "calculateAll") {
  calculateAllPilotsStatistics();
} else if (operation === "processAll" || operation === undefined) { // Изменено здесь
  processAllData();
}