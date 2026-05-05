import pkg from "pg";

const {Client} = pkg;

export function createDbClient(dbConfig) {
    return new Client({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database
    });
}

