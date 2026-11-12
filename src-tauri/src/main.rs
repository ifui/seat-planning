//! Tauri v1 桌面入口：本地文件命令 + 内置 SQLite 命令。
//!
//! 前端通过 `src/platform/files.ts` 与 `src/data/sqlite-repository.ts` 调用这里：
//! - `save_file_bytes`：把导出内容写到用户在保存对话框里选定的路径；
//! - `db_execute` / `db_select`：在应用数据目录下的 seat-planning.db 上执行 SQL。
//!
//! 打印走 WebView2 的原生 `window.print()`，不再需要落临时页或系统浏览器。
//!
//! v1 没有官方 SQL 插件可用，因此用 rusqlite 复刻原插件暴露的 execute/select 语义，
//! 前端仓储实现只换调用通道，表结构与接口边界保持不变。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Value};
use tauri::{Manager, State};

/// 单连接串行访问：仓储层的读写都是短事务，加锁即可避免并发写冲突
struct Db(Mutex<Connection>);

fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        // 嵌套结构按 JSON 文本存，与「一行一条领域对象」的表结构一致
        other => SqlValue::Text(other.to_string()),
    }
}

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => Value::from(STANDARD.encode(b)),
    }
}

/// 把 base64 内容写入指定路径（路径来自前端保存对话框）
#[tauri::command]
fn save_file_bytes(path: String, base64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("文件内容解码失败: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))
}

/// 执行写语句，返回受影响行数
#[tauri::command]
fn db_execute(db: State<Db>, sql: String, params: Vec<Value>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let values = params.iter().map(json_to_sql).collect::<Vec<_>>();
    conn.execute(&sql, params_from_iter(values))
        .map_err(|e| format!("SQL 执行失败: {e}"))
}

/// 执行查询，按列名返回 JSON 行
#[tauri::command]
fn db_select(db: State<Db>, sql: String, params: Vec<Value>) -> Result<Vec<Value>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("SQL 准备失败: {e}"))?;
    let columns = stmt
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let values = params.iter().map(json_to_sql).collect::<Vec<_>>();
    let mut rows = stmt
        .query(params_from_iter(values))
        .map_err(|e| format!("SQL 查询失败: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = Map::new();
        for (i, name) in columns.iter().enumerate() {
            let cell = row.get_ref(i).map_err(|e| e.to_string())?;
            obj.insert(name.clone(), sql_to_json(cell));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path_resolver().app_data_dir().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::Other, "无法定位应用数据目录")
            })?;
            fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("seat-planning.db"))?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_file_bytes,
            db_execute,
            db_select
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
