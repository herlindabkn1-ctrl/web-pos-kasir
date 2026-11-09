import json
import math
import os
import secrets
import sqlite3
from datetime import datetime

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config["DATABASE"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toko.db")

INITIAL_PRODUCTS = [
    ("S001", "Beras Premium 5kg", 18, 5, 68000, 75000, 0, "Sembako"),
    ("S002", "Beras Medium 5kg", 18, 5, 62000, 69000, 0, "Sembako"),
    ("S003", "Minyak Goreng 1L", 18, 5, 17000, 19000, 0, "Sembako"),
    ("S004", "Minyak Goreng 2L", 15, 4, 33000, 36000, 0, "Sembako"),
    ("S005", "Gula Pasir 1kg", 18, 5, 16000, 18000, 0, "Sembako"),
    ("S006", "Telur Ayam 1kg", 15, 5, 27000, 30000, 0, "Sembako"),
    ("S007", "Tepung Terigu 1kg", 18, 5, 11000, 13000, 0, "Sembako"),
    ("S008", "Garam Dapur 500g", 18, 5, 2500, 3500, 0, "Bumbu Dapur"),
    ("S009", "Mi Instan", 20, 6, 2800, 3500, 0, "Makanan & Minuman"),
    ("S010", "Kopi Sachet", 20, 6, 1000, 1500, 0, "Makanan & Minuman"),
    ("S011", "Teh Celup 25 Kantong", 15, 4, 9000, 11000, 0, "Makanan & Minuman"),
    ("S012", "Susu UHT 1L", 15, 4, 18000, 21000, 0, "Makanan & Minuman"),
    ("S013", "Kecap Manis 600ml", 15, 4, 18000, 22000, 0, "Bumbu Dapur"),
    ("S014", "Saus Sambal 340ml", 15, 4, 12000, 15000, 0, "Bumbu Dapur"),
    ("S015", "Sarden Kaleng 155g", 15, 4, 12000, 15000, 0, "Makanan & Minuman"),
    ("S016", "Santan Instan 200ml", 15, 4, 6000, 8000, 0, "Bumbu Dapur"),
    ("S017", "Sabun Cuci Piring 700ml", 12, 3, 14000, 17000, 0, "Kebutuhan Dapur"),
    ("S018", "Spons Cuci Piring", 12, 3, 3000, 5000, 0, "Kebutuhan Dapur"),
]


def get_db_connection():
    os.makedirs(app.instance_path, exist_ok=True)
    conn = sqlite3.connect(app.config["DATABASE"], timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS produk (
                kode TEXT PRIMARY KEY,
                nama TEXT NOT NULL,
                stok INTEGER NOT NULL CHECK (stok >= 0),
                min_stok INTEGER NOT NULL CHECK (min_stok >= 0),
                harga_beli REAL NOT NULL,
                harga_jual REAL NOT NULL,
                terjual INTEGER NOT NULL DEFAULT 0 CHECK (terjual >= 0),
                kategori TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS transaksi (
                nota TEXT PRIMARY KEY,
                tanggal TEXT NOT NULL,
                total REAL NOT NULL,
                laba REAL NOT NULL,
                keranjang_json TEXT NOT NULL
            );
            """
        )
        product_count = conn.execute("SELECT COUNT(*) FROM produk").fetchone()[0]
        if product_count == 0:
            conn.executemany("INSERT INTO produk VALUES (?, ?, ?, ?, ?, ?, ?, ?)", INITIAL_PRODUCTS)
        conn.commit()
    finally:
        conn.close()


@app.template_filter("rupiah")
def rupiah(amount):
    return f"Rp{amount:,.0f}".replace(",", ".")


def json_error(message, status=400):
    return jsonify({"status": "error", "message": message}), status


@app.get("/")
def index():
    conn = get_db_connection()
    try:
        produk_list = conn.execute("SELECT * FROM produk ORDER BY nama").fetchall()
        transaksi_list = conn.execute(
            "SELECT * FROM transaksi ORDER BY tanggal DESC, nota DESC"
        ).fetchall()
    finally:
        conn.close()

    stok_kritis = [product for product in produk_list if product["stok"] <= product["min_stok"]]
    dead_stock = [
        product for product in produk_list if product["terjual"] <= 5 and product["stok"] > 20
    ]
    return render_template(
        "index.html",
        barang=produk_list,
        stok_kritis=stok_kritis,
        dead_stock=dead_stock,
        total_omset=sum(trx["total"] for trx in transaksi_list),
        total_laba=sum(trx["laba"] for trx in transaksi_list),
        transaksi=transaksi_list,
    )


@app.route("/kasir", methods=["GET", "POST"])
def kasir():
    if request.method == "POST":
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return json_error("Format permintaan tidak valid.")

        keranjang = data.get("keranjang")
        if not isinstance(keranjang, list) or not keranjang:
            return json_error("Keranjang kosong!")

        try:
            bayar = float(data.get("bayar", 0))
        except (TypeError, ValueError):
            return json_error("Jumlah pembayaran tidak valid.")
        if not math.isfinite(bayar) or bayar < 0 or not bayar.is_integer():
            return json_error("Jumlah pembayaran tidak valid.")

        quantities = {}
        for item in keranjang:
            if not isinstance(item, dict):
                return json_error("Data produk di keranjang tidak valid.")
            product_id = item.get("id")
            quantity = item.get("qty")
            if (
                not isinstance(product_id, str)
                or not product_id
                or isinstance(quantity, bool)
                or not isinstance(quantity, int)
                or quantity <= 0
                or quantity > 2**31 - 1
            ):
                return json_error("Kode produk atau jumlah barang tidak valid.")
            quantities[product_id] = quantities.get(product_id, 0) + quantity
            if quantities[product_id] > 2**31 - 1:
                return json_error("Jumlah produk di keranjang terlalu besar.")

        conn = get_db_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            total_transaksi = 0
            total_laba_transaksi = 0
            detail_struk = []

            for product_id, quantity in quantities.items():
                product = conn.execute(
                    "SELECT * FROM produk WHERE kode = ?", (product_id,)
                ).fetchone()
                if product is None:
                    conn.rollback()
                    return json_error(f"Produk dengan kode {product_id} tidak ditemukan.")
                if product["stok"] < quantity:
                    conn.rollback()
                    return json_error(f"Stok {product['nama']} tidak mencukupi!")

                subtotal = product["harga_jual"] * quantity
                total_transaksi += subtotal
                total_laba_transaksi += (product["harga_jual"] - product["harga_beli"]) * quantity
                detail_struk.append(
                    {
                        "id": product_id,
                        "nama": product["nama"],
                        "qty": quantity,
                        "harga": product["harga_jual"],
                        "subtotal": subtotal,
                        "stok": product["stok"] - quantity,
                    }
                )

            if bayar < total_transaksi:
                conn.rollback()
                return json_error("Uang pembayaran kurang!")

            for product_id, quantity in quantities.items():
                conn.execute(
                    "UPDATE produk SET stok = stok - ?, terjual = terjual + ? WHERE kode = ?",
                    (quantity, quantity, product_id),
                )

            now = datetime.now()
            tanggal = now.strftime("%Y-%m-%d %H:%M")
            nota_baru = f"TRX{now:%Y%m%d%H%M%S}{secrets.token_hex(3).upper()}"
            conn.execute(
                "INSERT INTO transaksi VALUES (?, ?, ?, ?, ?)",
                (
                    nota_baru,
                    tanggal,
                    total_transaksi,
                    total_laba_transaksi,
                    json.dumps(detail_struk, ensure_ascii=False),
                ),
            )
            conn.commit()
            return jsonify(
                {
                    "status": "success",
                    "nota": nota_baru,
                    "total": total_transaksi,
                    "kembalian": bayar - total_transaksi,
                    "tanggal": tanggal,
                    "items": detail_struk,
                }
            )
        except sqlite3.Error:
            conn.rollback()
            app.logger.exception("Gagal menyimpan transaksi kasir")
            return json_error("Transaksi gagal disimpan. Silakan coba kembali.", 500)
        finally:
            conn.close()

    conn = get_db_connection()
    try:
        produk_list = conn.execute("SELECT * FROM produk ORDER BY nama").fetchall()
    finally:
        conn.close()
    return render_template("kasir.html", barang=produk_list)


init_db()


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=5000)
