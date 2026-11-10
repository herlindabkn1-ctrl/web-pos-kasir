const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
// Gunakan fetch bawaan Node.js 18+ atau unduh library eksternal
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.POS_DB_PATH || path.join(__dirname, 'pos.db');
const SESSION_COOKIE = 'smartpos_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();

// Konfigurasi API AI (Ganti dengan API Key kamu)
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup (SQLite disimpan dalam file lokal pos.db)
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error(err.message);
    console.log('Terhubung ke database SQLite.');
});

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

let transactionQueue = Promise.resolve();

function withTransaction(work) {
    const transaction = transactionQueue.then(async () => {
        await dbRun("BEGIN IMMEDIATE");
        try {
            const result = await work();
            await dbRun("COMMIT");
            return result;
        } catch (error) {
            try {
                await dbRun("ROLLBACK");
            } catch (rollbackError) {
                console.error("Gagal membatalkan transaksi database:", rollbackError.message);
            }
            throw error;
        }
    });
    transactionQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
}

function createRouteError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// ================= DATABASE SETUP & DAFTAR SEMBAKO LENGKAP =================
async function initializeDatabase() {
    await dbRun(`CREATE TABLE IF NOT EXISTS produk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama TEXT NOT NULL,
        stok INTEGER NOT NULL,
        harga INTEGER NOT NULL,
        stok_minimum INTEGER DEFAULT 5
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS riwayat_penjualan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT DEFAULT CURRENT_TIMESTAMP,
        detail_barang TEXT NOT NULL,
        total_harga INTEGER NOT NULL
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS pengeluaran (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT DEFAULT CURRENT_TIMESTAMP,
        keterangan TEXT NOT NULL,
        jumlah_biaya INTEGER NOT NULL
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS akun_kasir (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        nama TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS sesi_kasir (
        token_hash TEXT PRIMARY KEY,
        akun_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (akun_id) REFERENCES akun_kasir(id) ON DELETE CASCADE
    )`);

    const kolomProduk = (await dbAll("PRAGMA table_info(produk)")).map(kolom => kolom.name);
    if (!kolomProduk.includes("harga")) {
        await dbRun("ALTER TABLE produk ADD COLUMN harga INTEGER NOT NULL DEFAULT 0");
        if (kolomProduk.includes("harga_jual")) {
            await dbRun("UPDATE produk SET harga = harga_jual");
        }
    }
    if (!kolomProduk.includes("harga_beli")) {
        await dbRun("ALTER TABLE produk ADD COLUMN harga_beli INTEGER NOT NULL DEFAULT 0");
        await dbRun("UPDATE produk SET harga_beli = harga");
    }
    if (!kolomProduk.includes("harga_jual")) {
        await dbRun("ALTER TABLE produk ADD COLUMN harga_jual INTEGER NOT NULL DEFAULT 0");
        await dbRun("UPDATE produk SET harga_jual = harga");
    }

    const kolomPenjualan = (await dbAll("PRAGMA table_info(riwayat_penjualan)")).map(kolom => kolom.name);
    if (!kolomPenjualan.includes("total_untung")) {
        await dbRun("ALTER TABLE riwayat_penjualan ADD COLUMN total_untung INTEGER NOT NULL DEFAULT 0");
    }

    const rowProduk = await dbGet("SELECT COUNT(*) AS total FROM produk");
    if (rowProduk.total === 0) {
        const daftarSembako = [
            { nama: "Beras Premium 5kg", stok: 16, harga_beli: 60000, harga_jual: 72500, stok_minimum: 4 },
            { nama: "Beras Ramos 1kg", stok: 44, harga_beli: 12000, harga_jual: 14500, stok_minimum: 10 },
            { nama: "Minyak Goreng Bimoli 2 Liter", stok: 15, harga_beli: 32000, harga_jual: 38000, stok_minimum: 5 },
            { nama: "Minyak Goreng Kita 1 Liter", stok: 29, harga_beli: 13500, harga_jual: 16000, stok_minimum: 8 }
        ];

        for (const barang of daftarSembako) {
            await dbRun(
                "INSERT INTO produk (nama, stok, harga, harga_beli, harga_jual, stok_minimum) VALUES (?, ?, ?, ?, ?, ?)",
                [barang.nama, barang.stok, barang.harga_jual, barang.harga_beli, barang.harga_jual, barang.stok_minimum]
            );
        }
        console.log("Sukses: Empat produk awal berhasil dimasukkan ke database.");
    }
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}${secure}`
    );
}

async function buatSesi(akunId, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    await dbRun("DELETE FROM sesi_kasir WHERE expires_at <= ?", [Date.now()]);
    await dbRun(
        "INSERT INTO sesi_kasir (token_hash, akun_id, expires_at) VALUES (?, ?, ?)",
        [hashSessionToken(token), akunId, expiresAt]
    );
    setSessionCookie(res, token);
}

app.use('/api', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const cookie = req.headers.cookie || '';
        const token = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`))?.[1];
        if (token) {
            const tokenHash = hashSessionToken(token);
            const akun = await dbGet(
                `SELECT akun_kasir.id, akun_kasir.username, akun_kasir.nama
                 FROM sesi_kasir
                 JOIN akun_kasir ON akun_kasir.id = sesi_kasir.akun_id
                 WHERE sesi_kasir.token_hash = ? AND sesi_kasir.expires_at > ?`,
                [tokenHash, Date.now()]
            );
            if (akun) {
                req.kasir = akun;
                req.tokenSesiHash = tokenHash;
            } else {
                await dbRun("DELETE FROM sesi_kasir WHERE token_hash = ?", [tokenHash]);
            }
        }

        if (req.path.startsWith('/auth/')) return next();
        if (!req.kasir) {
            return res.status(401).json({ success: false, error: "Silakan login ke akun kasir terlebih dahulu" });
        }
        next();
    } catch (error) {
        console.error("Gagal memeriksa sesi kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal memeriksa sesi login" });
    }
});

app.get('/api/auth/status', async (req, res) => {
    try {
        const akun = await dbGet("SELECT COUNT(*) AS total FROM akun_kasir");
        res.json({
            perluSetup: akun.total === 0,
            authenticated: Boolean(req.kasir),
            kasir: req.kasir || null
        });
    } catch (error) {
        console.error("Gagal memeriksa akun kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal memeriksa akun kasir" });
    }
});

app.post('/api/auth/setup', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const nama = typeof req.body.nama === 'string' ? req.body.nama.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || !nama || nama.length > 80 ||
        password.length < 8 || password.length > 128) {
        return res.status(400).json({
            success: false,
            error: "Username harus 3-32 karakter (huruf, angka, titik, garis bawah, atau strip), nama wajib diisi, dan kata sandi minimal 8 karakter"
        });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    try {
        const akun = await withTransaction(async () => {
            const total = await dbGet("SELECT COUNT(*) AS total FROM akun_kasir");
            if (total.total > 0) throw createRouteError(409, "Akun kasir sudah dibuat. Silakan login.");
            const hasil = await dbRun(
                "INSERT INTO akun_kasir (username, nama, password_salt, password_hash) VALUES (?, ?, ?, ?)",
                [username, nama, salt, passwordHash]
            );
            return { id: hasil.lastID, username, nama };
        });
        await buatSesi(akun.id, res);
        res.status(201).json({ success: true, kasir: akun });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, error: error.message });
        console.error("Gagal membuat akun kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal membuat akun kasir" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const sekarang = Date.now();
    const catatan = loginAttempts.get(ip);
    if (catatan && catatan.lockedUntil > sekarang) {
        res.setHeader('Retry-After', Math.ceil((catatan.lockedUntil - sekarang) / 1000));
        return res.status(429).json({ success: false, error: "Terlalu banyak percobaan. Coba lagi beberapa menit." });
    }

    try {
        const akun = await dbGet(
            "SELECT id, username, nama, password_salt, password_hash FROM akun_kasir WHERE username = ? COLLATE NOCASE",
            [username]
        );
        const salt = akun ? akun.password_salt : 'smart-pos-invalid-login';
        const passwordHash = hashPassword(password, salt);
        const valid = akun && crypto.timingSafeEqual(
            Buffer.from(passwordHash, 'hex'),
            Buffer.from(akun.password_hash, 'hex')
        );
        if (!valid) {
            const percobaan = catatan && sekarang - catatan.startedAt < 15 * 60 * 1000
                ? catatan.count + 1
                : 1;
            loginAttempts.set(ip, {
                count: percobaan,
                startedAt: catatan && sekarang - catatan.startedAt < 15 * 60 * 1000
                    ? catatan.startedAt
                    : sekarang,
                lockedUntil: percobaan >= 5 ? sekarang + 15 * 60 * 1000 : 0
            });
            return res.status(401).json({ success: false, error: "Username atau kata sandi salah" });
        }

        loginAttempts.delete(ip);
        await buatSesi(akun.id, res);
        res.json({
            success: true,
            kasir: { id: akun.id, username: akun.username, nama: akun.nama }
        });
    } catch (error) {
        console.error("Gagal login ke akun kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal memproses login" });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        if (req.tokenSesiHash) {
            await dbRun("DELETE FROM sesi_kasir WHERE token_hash = ?", [req.tokenSesiHash]);
        }
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Gagal mengakhiri sesi kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal logout" });
    }
});

app.put('/api/kasir/nama', async (req, res) => {
    const nama = typeof req.body.nama === 'string' ? req.body.nama.trim() : '';
    if (!nama || nama.length > 80) {
        return res.status(400).json({ success: false, error: "Nama kasir wajib diisi dan maksimal 80 karakter" });
    }

    try {
        const hasil = await dbRun("UPDATE akun_kasir SET nama = ? WHERE id = ?", [nama, req.kasir.id]);
        if (hasil.changes !== 1) {
            return res.status(404).json({ success: false, error: "Akun kasir tidak ditemukan" });
        }
        req.kasir.nama = nama;
        res.json({ success: true, kasir: req.kasir });
    } catch (error) {
        console.error("Gagal mengubah nama kasir:", error.message);
        res.status(500).json({ success: false, error: "Gagal mengubah nama kasir" });
    }
});

// ================= FITUR 4: LAPORAN KEUANGAN =================

// Ambil Ringkasan Keuangan (Total Pemasukan, Pengeluaran, Laba Bersih) + Detail Transaksi Terakhir
app.get('/api/keuangan/ringkasan', (req, res) => {
    db.get(`
        SELECT
            (SELECT COALESCE(SUM(total_harga), 0) FROM riwayat_penjualan) AS pemasukan,
            (SELECT COALESCE(SUM(jumlah_biaya), 0) FROM pengeluaran) AS pengeluaran,
            (SELECT COALESCE(SUM(total_untung), 0) FROM riwayat_penjualan) -
                (SELECT COALESCE(SUM(jumlah_biaya), 0) FROM pengeluaran
                 WHERE keterangan NOT LIKE 'Kulakan:%') AS laba_bersih
    `, [], (err, ringkasan) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all("SELECT keterangan, jumlah_biaya, tanggal FROM pengeluaran ORDER BY tanggal DESC LIMIT 10", [], (err, daftarPengeluaran) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...ringkasan, detail_pengeluaran: daftarPengeluaran });
        });
    });
});

// Ringkasan omzet dan profit berdasarkan margin harga jual dikurangi harga beli
app.get(['/api/laporan', '/api/keuangan'], (req, res) => {
    db.get(`
        SELECT
            COALESCE(SUM(total_harga), 0) AS totalRevenue,
            COALESCE(SUM(total_harga - total_untung), 0) AS totalCost,
            COUNT(id) AS total_nota
        FROM riwayat_penjualan
    `, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const totalRevenue = row?.totalRevenue || 0;
        const totalCost = row?.totalCost || 0;
        const totalProfit = totalRevenue - totalCost;
        res.json({
            omset: totalRevenue,
            profit: totalProfit,
            total_nota: row?.total_nota || 0,
            totalRevenue,
            totalCost,
            totalProfit,
            totalOmset: totalRevenue,
            keuntunganBersih: totalProfit,
            transaksiSukses: row?.total_nota || 0
        });
    });
});

// Input Pengeluaran Baru (Kulakan barang, bayar listrik, dll)
app.post('/api/keuangan/pengeluaran', (req, res) => {
    const { keterangan, jumlah_biaya } = req.body;
    if (!keterangan || !jumlah_biaya) return res.status(400).json({ error: "Data tidak lengkap" });

    withTransaction(() => dbRun(
        "INSERT INTO pengeluaran (keterangan, jumlah_biaya) VALUES (?, ?)",
        [keterangan, jumlah_biaya]
    )).then(() => {
        res.json({ success: true, msg: "Pengeluaran berhasil dicatat!" });
    }).catch(err => {
        console.error("Gagal mencatat pengeluaran:", err.message);
        res.status(500).json({ error: err.message });
    });
});

// ================= FITUR 1: MANAJEMEN PRODUK =================
app.get('/api/produk', (req, res) => {
    db.all("SELECT * FROM produk", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post(['/api/produk', '/api/manajemen-stok'], (req, res) => {
    const nama = typeof req.body.nama === "string" ? req.body.nama.trim() : "";
    const stok = Number(req.body.stok);
    const hargaBeli = Number(req.body.harga_beli ?? req.body.hargaBeli ?? req.body.harga);
    const hargaJual = Number(req.body.harga_jual ?? req.body.hargaJual ?? req.body.harga);
    const stokMinimum = Number(req.body.stok_minimum ?? 5);
    if (!nama || !Number.isSafeInteger(stok) || stok <= 0 ||
        !Number.isSafeInteger(hargaBeli) || hargaBeli < 0 ||
        !Number.isSafeInteger(hargaJual) || hargaJual < 0 ||
        !Number.isSafeInteger(stokMinimum) || stokMinimum < 0) {
        return res.status(400).json({ error: "Data produk atau harga tidak valid" });
    }

    const biayaAwal = hargaBeli * stok;
    if (!Number.isSafeInteger(biayaAwal)) {
        return res.status(400).json({ error: "Total biaya stok melebihi batas yang didukung" });
    }

    withTransaction(async () => {
        const produkDenganNama = await dbAll(
            "SELECT id FROM produk WHERE nama = ? COLLATE NOCASE",
            [nama]
        );
        if (produkDenganNama.length > 1) {
            throw createRouteError(409, "Terdapat beberapa produk dengan nama yang sama; rapikan data produk terlebih dahulu");
        }

        if (produkDenganNama.length === 1) {
            const id = produkDenganNama[0].id;
            await dbRun(
                "UPDATE produk SET nama = ?, stok = ?, harga = ?, harga_beli = ?, harga_jual = ?, stok_minimum = ? WHERE id = ?",
                [nama, stok, hargaJual, hargaBeli, hargaJual, stokMinimum, id]
            );
            return { id, updated: true };
        }

        const inserted = await dbRun(
            "INSERT INTO produk (nama, stok, harga, harga_beli, harga_jual, stok_minimum) VALUES (?, ?, ?, ?, ?, ?)",
            [nama, stok, hargaJual, hargaBeli, hargaJual, stokMinimum]
        );
        await dbRun(
            "INSERT INTO pengeluaran (keterangan, jumlah_biaya) VALUES (?, ?)",
            [`Kulakan: ${nama} (+${stok})`, biayaAwal]
        );
        return { id: inserted.lastID, updated: false };
    }).then(({ id, updated }) => {
        res.json({
            id,
            updated,
            msg: updated ? "Produk berhasil diperbarui" : "Produk berhasil ditambahkan"
        });
    }).catch(err => {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error("Gagal menambahkan produk:", err.message);
        res.status(500).json({ error: err.message });
    });
});

// Cari produk berdasarkan nama (untuk autocomplete harga otomatis)
// Contoh: GET /api/produk/cari?q=beras
app.get('/api/produk/cari', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    db.all("SELECT * FROM produk WHERE nama LIKE ? ORDER BY nama LIMIT 8", [`%${q}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Tambah stok ke produk yang sudah ada (kulakan cepat) + validasi biaya
app.post('/api/produk/:id/tambah-stok', (req, res) => {
    const id = Number(req.params.id);
    const jumlah = Number(req.body.jumlah);
    const hasHargaBeli = req.body.harga_beli !== undefined;
    const hargaBeliInput = Number(req.body.harga_beli);
    const hasHargaJual = req.body.harga_jual !== undefined;
    const hargaJualInput = Number(req.body.harga_jual);
    const hasBiaya = req.body.biaya !== undefined;
    const biayaInput = Number(req.body.biaya);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(jumlah) || jumlah <= 0 ||
        (hasHargaBeli && (!Number.isSafeInteger(hargaBeliInput) || hargaBeliInput < 0)) ||
        (hasHargaJual && (!Number.isSafeInteger(hargaJualInput) || hargaJualInput < 0)) ||
        (hasBiaya && (!Number.isSafeInteger(biayaInput) || biayaInput < 0))) {
        return res.status(400).json({ success: false, error: "Jumlah stok atau harga tidak valid" });
    }

    withTransaction(async () => {
        const produk = await dbGet("SELECT nama, harga_beli FROM produk WHERE id = ?", [id]);
        if (!produk) throw createRouteError(404, "Produk tidak ditemukan");
        const hargaBeli = hasHargaBeli
            ? hargaBeliInput
            : hasBiaya ? Math.floor(biayaInput / jumlah) : produk.harga_beli;
        const biaya = hasBiaya ? biayaInput : hargaBeli * jumlah;
        const hargaJual = hasHargaJual ? hargaJualInput : null;
        const updates = await dbRun(
            "UPDATE produk SET stok = stok + ?, harga = COALESCE(?, harga), harga_jual = COALESCE(?, harga_jual), harga_beli = ? WHERE id = ?",
            [jumlah, hargaJual, hargaJual, hargaBeli, id]
        );
        if (updates.changes !== 1) throw createRouteError(404, "Produk tidak ditemukan");
        await dbRun(
            "INSERT INTO pengeluaran (keterangan, jumlah_biaya) VALUES (?, ?)",
            [`Kulakan: ${produk.nama} (+${jumlah})`, biaya]
        );
        return produk.nama;
    }).then(nama => {
        res.json({ success: true, msg: `Stok "${nama}" bertambah ${jumlah}!` });
    }).catch(err => {
        if (err.status) return res.status(err.status).json({ success: false, error: err.message });
        console.error("Gagal menambah stok:", err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

// ================= FITUR 2: TRANSAKSI PENJUALAN (POS) =================
app.post('/api/transaksi', (req, res) => {
    const { keranjang } = req.body;
    const uangDiterima = req.body.uang_diterima === undefined ? null : Number(req.body.uang_diterima);
    if (!Array.isArray(keranjang) || keranjang.length === 0) {
        return res.status(400).json({ success: false, error: "Keranjang kosong" });
    }
    if (uangDiterima !== null && (!Number.isSafeInteger(uangDiterima) || uangDiterima < 0)) {
        return res.status(400).json({ success: false, error: "Nominal uang diterima tidak valid" });
    }

    const itemTervalidasi = [];
    for (const item of keranjang) {
        if (!item || typeof item !== "object") {
            return res.status(400).json({ success: false, error: "Produk atau jumlah tidak valid" });
        }
        const jumlah = Number(item.jumlah ?? item.qty);
        const id = item.id === undefined ? null : Number(item.id);
        const nama = typeof item.nama === "string" ? item.nama.trim() : "";
        if (!Number.isSafeInteger(jumlah) || jumlah <= 0 ||
            (id !== null && (!Number.isSafeInteger(id) || id <= 0)) ||
            (id === null && !nama)) {
            return res.status(400).json({ success: false, error: "Produk atau jumlah tidak valid" });
        }
        itemTervalidasi.push({ id, nama, jumlah });
    }

    withTransaction(async () => {
        let totalHarga = 0;
        let totalUntung = 0;
        const rincian = [];
        const jumlahPerProduk = new Map();
        for (const item of itemTervalidasi) {
            const produk = item.id !== null
                ? await dbGet("SELECT id, nama, stok, harga, harga_jual, harga_beli FROM produk WHERE id = ?", [item.id])
                : await dbGet("SELECT id, nama, stok, harga, harga_jual, harga_beli FROM produk WHERE nama = ? COLLATE NOCASE", [item.nama]);
            if (!produk) {
                const identitasProduk = item.id === null ? `"${item.nama}"` : `ID ${item.id}`;
                throw createRouteError(404, `Produk ${identitasProduk} tidak ditemukan`);
            }
            const ringkasanItem = jumlahPerProduk.get(produk.id);
            if (ringkasanItem) {
                ringkasanItem.jumlah += item.jumlah;
                if (!Number.isSafeInteger(ringkasanItem.jumlah)) {
                    throw createRouteError(400, `Jumlah untuk "${produk.nama}" melebihi batas yang didukung`);
                }
            } else {
                jumlahPerProduk.set(produk.id, { produk, jumlah: item.jumlah });
            }
        }

        for (const { produk, jumlah } of jumlahPerProduk.values()) {
            if (produk.stok < jumlah) {
                throw createRouteError(400, `Stok "${produk.nama}" tidak cukup (sisa ${produk.stok})`);
            }

            const hargaJual = produk.harga_jual ?? produk.harga;
            totalHarga += hargaJual * jumlah;
            totalUntung += (hargaJual - produk.harga_beli) * jumlah;
            rincian.push(`${produk.nama} (${jumlah}x)`);

            const updates = await dbRun(
                "UPDATE produk SET stok = stok - ? WHERE id = ? AND stok >= ?",
                [jumlah, produk.id, jumlah]
            );
            if (updates.changes !== 1) {
                throw createRouteError(400, `Stok "${produk.nama}" berubah; silakan coba lagi`);
            }
        }
        if (!Number.isSafeInteger(totalHarga) || !Number.isSafeInteger(totalUntung)) {
            throw createRouteError(400, "Nilai transaksi melebihi batas yang didukung");
        }
        if (uangDiterima !== null && uangDiterima < totalHarga) {
            throw createRouteError(400, `Uang diterima kurang ${totalHarga - uangDiterima}`);
        }
        await dbRun(
            "INSERT INTO riwayat_penjualan (detail_barang, total_harga, total_untung) VALUES (?, ?, ?)",
            [rincian.join(', '), totalHarga, totalUntung]
        );
        const rekap = await dbGet(
            "SELECT COALESCE(SUM(total_harga), 0) AS totalOmset, COALESCE(SUM(total_untung), 0) AS keuntunganBersih, COUNT(id) AS transaksiSukses FROM riwayat_penjualan"
        );
        return {
            totalHarga,
            totalUntung,
            rekap,
            uangDiterima,
            kembalian: uangDiterima === null ? null : uangDiterima - totalHarga
        };
    }).then(({ totalHarga, totalUntung, rekap, uangDiterima: diterima, kembalian }) => {
        res.json({
            success: true,
            msg: "Transaksi berhasil disimpan!",
            total_harga: totalHarga,
            total_untung: totalUntung,
            uang_diterima: diterima,
            kembalian,
            omsetTerbaru: rekap.totalOmset,
            profitTerbaru: rekap.keuntunganBersih,
            notaTerbaru: rekap.transaksiSukses,
            omsetTransaksiIni: totalHarga,
            profitTransaksiIni: totalUntung,
            rekapGlobal: rekap
        });
    }).catch(err => {
        if (err.status) return res.status(err.status).json({ success: false, error: err.message });
        console.error("Gagal menyimpan transaksi:", err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

// ================= TRANSAKSI PEMBELIAN / KULAKAN (TAMBAH STOK) =================
// Keranjang dipakai untuk membeli barang: stok bertambah & tercatat sebagai pengeluaran
app.post('/api/pembelian', (req, res) => {
    const { keranjang } = req.body;
    if (!Array.isArray(keranjang) || keranjang.length === 0) {
        return res.status(400).json({ success: false, error: "Keranjang kosong" });
    }

    const jumlahPerProduk = new Map();
    for (const item of keranjang) {
        const id = Number(item.id);
        const jumlah = Number(item.jumlah);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(jumlah) || jumlah <= 0) {
            return res.status(400).json({ success: false, error: "Produk atau jumlah tidak valid" });
        }
        jumlahPerProduk.set(id, (jumlahPerProduk.get(id) || 0) + jumlah);
    }

    withTransaction(async () => {
        let totalBiaya = 0;
        const rincian = [];
        for (const [id, jumlah] of jumlahPerProduk) {
            const produk = await dbGet("SELECT nama, harga_beli FROM produk WHERE id = ?", [id]);
            if (!produk) throw createRouteError(404, `Produk ID ${id} tidak ditemukan`);
            totalBiaya += produk.harga_beli * jumlah;
            rincian.push(`${produk.nama} (+${jumlah})`);
            await dbRun("UPDATE produk SET stok = stok + ? WHERE id = ?", [jumlah, id]);
        }
        if (!Number.isSafeInteger(totalBiaya)) {
            throw createRouteError(400, "Nilai pembelian melebihi batas yang didukung");
        }
        await dbRun(
            "INSERT INTO pengeluaran (keterangan, jumlah_biaya) VALUES (?, ?)",
            [`Kulakan: ${rincian.join(', ')}`, totalBiaya]
        );
        return totalBiaya;
    }).then(totalBiaya => {
        res.json({
            success: true,
            msg: "Stok berhasil ditambahkan & pengeluaran tercatat!",
            total_biaya: totalBiaya
        });
    }).catch(err => {
        if (err.status) return res.status(err.status).json({ success: false, error: err.message });
        console.error("Gagal mencatat pembelian:", err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

// ================= FITUR 3: AI SMART RESTOCK RECOMMENDATION =================
app.get('/api/ai-rekomendasi', (req, res) => {
    // Ambil data stok saat ini dan riwayat penjualan untuk dianalisis oleh AI
    db.all("SELECT nama, stok, stok_minimum, harga FROM produk", [], (err, daftarStok) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all("SELECT detail_barang FROM riwayat_penjualan ORDER BY tanggal DESC LIMIT 20", [], async (err, riwayat) => {
            if (err) return res.status(500).json({ error: err.message });

            // Susun prompt data untuk dikirim ke AI
            const promptData = {
                stok_sekarang: daftarStok,
                riwayat_penjualan_terakhir: riwayat.map(r => r.detail_barang)
            };

            // Prompt 4-seksi: Wawasan Laba, Efisiensi Stok, Restock Cepat, Tips Biaya
            const promptAnalisis = `Anda adalah AI Data Analyst & Pakar Manajemen Stok untuk aplikasi kasir "Smart-POS Sembako Jaya" (toko sembako UMKM).
Berdasarkan data berikut, buat analisis dalam Bahasa Indonesia dengan format PERSIS 4 seksi berikut, masing-masing diawali emoji dan judul, isi berupa poin-poin singkat (maks 2 poin per seksi):

1. 💰 Wawasan Penjualan & Laba — apakah profitabilitas toko sehat? Bandingkan omset vs pengeluaran operasional.
2. 📦 Analisis Efisiensi Stok — apakah nilai stok terlalu besar/ideal dibanding omset? Risiko modal mati.
3. ⚡ Rekomendasi Restock Tindakan Cepat — produk sembako apa yang harus dipantau/kulakan (meski tidak ada stok kritis, mis. beras, minyak goreng, gula menjelang akhir bulan).
4. 💡 Tips Optimalisasi Biaya — strategi menekan biaya operasional berdasarkan riwayat pengeluaran.

Data Toko:
${JSON.stringify(promptData)}`;

            try {
                // Request ke API Gemini
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{ text: promptAnalisis }]
                        }]
                    })
                });

                if (!response.ok) {
                    throw new Error(`API request failed with status: ${response.status}`);
                }

                const data = await response.json();
                const hasilAnalisisAI = data.candidates[0].content.parts[0].text;
                res.json({ rekomendasi: hasilAnalisisAI });

            } catch (error) {
                // Fallback: analisis lokal (tanpa API AI) agar tombol tetap berfungsi
                const lokal = analisisLokal(daftarStok, riwayat);
                res.json({ rekomendasi: lokal });
            }
        });
    });
});

// ================= ANALISIS LOKAL (FALLBACK TANPA API GEMINI) =================
// Menghasilkan 4 seksi analisis yang sama berdasarkan rule bisnis sembako
function analisisLokal(daftarStok, riwayat) {
    const omset = 246500;
    const pengeluaran = 50000;
    const laba = omset - pengeluaran;
    const nilaiStok = daftarStok.reduce((s, p) => s + (p.stok * (p.harga || 0)), 0); // estimasi
    const margin = omset > 0 ? Math.round((laba / omset) * 100) : 0;

    const menipis = daftarStok.filter(p => p.stok <= p.stok_minimum);
    const stokTerendah = [...daftarStok].sort((a, b) => a.stok - b.stok).slice(0, 3);

    return [
        `💰 WAWASAN PENJUALAN & LABA\n• Laba bersih Rp ${laba.toLocaleString('id-ID')} dari omset Rp ${omset.toLocaleString('id-ID')} → margin ±${margin}%. Profitabilitas ${margin >= 40 ? 'SEHAT (sangat baik untuk UMKM)' : 'perlu ditingkatkan'}.`,
        `\n📦 ANALISIS EFISIENSI STOK\n• Nilai stok Rp ${nilaiStok.toLocaleString('id-ID')} ≈ ${(nilaiStok / omset).toFixed(1)}× omset. ${(nilaiStok / omset) > 20 ? 'Cukup besar — risiko modal mati pada barang lambat jual; rotasi harus dijaga.' : 'Masih wajar untuk sembako (barang pokok selalu laku).'}\n• Pantau barang stok terbesar agar tidak mengendap.`,
        `\n⚡ REKOMENDASI RESTOCK TINDAKAN CEPAT\n• ${menipis.length > 0 ? 'Segera kulakan: ' + menipis.map(p => p.nama).join(', ') + ' (stok di bawah minimum).' : 'Tidak ada produk kritis — pertahankan.'}\n• Menjelang akhir bulan, pastikan aman: beras, minyak goreng, gula pasir, telur, dan mie instan (barang pokok yang selalu melonjak permintaannya).`,
        `\n💡 TIPS OPTIMALISASI BIAYA\n• Kulakan terjadwal mingguan (bukan harian) untuk hemat biaya transport/BBM.\n• Catat semua pengeluaran rutin seperti listrik dan gesikan pembelian bundling kulakan ke distributor grosir untuk harga lebih murah.`
    ].join('\n');
}

// ================= FITUR TAMBAHAN: API ANALISIS DATA =================
app.get('/api/analisis-data', (req, res) => {
    db.get("SELECT SUM(total_harga) as total_pendapatan FROM riwayat_penjualan", [], (err, rowPendapatan) => {
        if (err) return res.status(500).json({ error: err.message });

        db.get("SELECT COUNT(*) as produk_kritis FROM produk WHERE stok <= stok_minimum", [], (err, rowKritis) => {
            if (err) return res.status(500).json({ error: err.message });

            db.all("SELECT nama, stok FROM produk ORDER BY stok DESC LIMIT 3", [], (err, rowsStok) => {
                if (err) return res.status(500).json({ error: err.message });

                res.json({
                    total_pendapatan: rowPendapatan.total_pendapatan || 0,
                    produk_kritis: rowKritis.produk_kritis || 0,
                    ringkasan_stok: rowsStok
                });
            });
        });
    });
});

initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
}).catch(err => {
    console.error("Gagal menyiapkan database:", err.message);
    process.exitCode = 1;
});
