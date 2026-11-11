import os
import sqlite3
from datetime import date, datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATABASE_PATH = Path(os.environ.get("POS_DB_PATH", BASE_DIR / "pos.db")).resolve()
MONTHS_ID = (
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
)

app = Flask(__name__, static_folder=str(PUBLIC_DIR))


def format_rupiah(amount):
    return f"Rp {int(amount):,}".replace(",", ".")


def format_date(value):
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{parsed.day:02d} {MONTHS_ID[parsed.month - 1][:3]} {parsed.year}"


def month_bounds(year, month):
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)
    return start.isoformat(), end.isoformat()


def get_dashboard_data(connection, year, month):
    start, end = month_bounds(year, month)
    summary = connection.execute(
        """
        SELECT COUNT(id) AS transaction_count,
               COALESCE(SUM(total_harga), 0) AS total_sales
        FROM riwayat_penjualan
        WHERE tanggal >= ? AND tanggal < ?
        """,
        (start, end),
    ).fetchone()

    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(riwayat_penjualan)")
    }
    if "kasir" in columns:
        cashier_sql = "COALESCE(NULLIF(r.kasir, ''), ?)"
        joins = ""
    elif "kasir_id" in columns:
        cashier_sql = "COALESCE(a.nama, ?)"
        joins = "LEFT JOIN akun_kasir AS a ON a.id = r.kasir_id"
    else:
        cashier_sql = "?"
        joins = ""

    transactions = connection.execute(
        f"""
        SELECT r.id, r.tanggal, r.total_harga, {cashier_sql} AS cashier
        FROM riwayat_penjualan AS r
        {joins}
        WHERE r.tanggal >= ? AND r.tanggal < ?
        ORDER BY r.tanggal DESC, r.id DESC
        LIMIT 10
        """,
        ("Linda", start, end),
    ).fetchall()

    total_sales = int(summary["total_sales"] or 0)
    return {
        "month": f"{year:04d}-{month:02d}",
        "month_label": f"{MONTHS_ID[month - 1]} {year}",
        "total_sales": total_sales,
        "total_sales_formatted": format_rupiah(total_sales),
        "transaction_count": int(summary["transaction_count"] or 0),
        "recent_transactions": [
            {
                "transaction_id": f"TRX-{row['id']:05d}",
                "date": row["tanggal"],
                "date_formatted": format_date(row["tanggal"]),
                "cashier": row["cashier"],
                "total": int(row["total_harga"] or 0),
                "total_formatted": format_rupiah(row["total_harga"] or 0),
            }
            for row in transactions
        ],
    }


def open_database():
    database_uri = f"{DATABASE_PATH.as_uri()}?mode=ro"
    connection = sqlite3.connect(database_uri, uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


@app.get("/")
def dashboard():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/api/dashboard")
def dashboard_data():
    month_value = request.args.get("month")
    if month_value:
        try:
            target_month = datetime.strptime(month_value, "%Y-%m")
            if target_month.strftime("%Y-%m") != month_value:
                raise ValueError("Format bulan tidak valid")
        except ValueError:
            return jsonify(error="Parameter month harus berformat YYYY-MM."), 400
        year, month = target_month.year, target_month.month
    else:
        today = date.today()
        year, month = today.year, today.month

    connection = None
    try:
        connection = open_database()
        return jsonify(get_dashboard_data(connection, year, month))
    except sqlite3.Error:
        app.logger.exception("Gagal membaca data dashboard dari SQLite")
        return jsonify(error="Gagal membaca data penjualan dari database POS."), 500
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )
