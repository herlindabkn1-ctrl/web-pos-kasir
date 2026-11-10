import sqlite3
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

def hubungkan_db():
    """
    Membuat dan menghubungkan ke database SQLite pos.db
    """
    conn = sqlite3.connect('pos.db')
    return conn

def analisis_stok_rendah(conn):
    """
    Menganalisis produk yang stoknya rendah
    """
    query = """
    SELECT nama, stok, harga, stok_minimum 
    FROM produk 
    WHERE stok <= stok_minimum 
    ORDER BY stok ASC
    """
    df = pd.read_sql_query(query, conn)
    return df

def analisis_penjualan(conn):
    """
    Menganalisis riwayat penjualan dari database
    """
    query = """
    SELECT tanggal, detail_barang, total_harga 
    FROM riwayat_penjualan 
    ORDER BY tanggal DESC
    LIMIT 50
    """
    df = pd.read_sql_query(query, conn)
    df['tanggal'] = pd.to_datetime(df['tanggal'])
    return df

def visualisasi_penjualan(df_penjualan):
    """
    Membuat visualisasi trend penjualan
    """
    df_penjualan = df_penjualan.copy()
    df_penjualan['tanggal_hari'] = df_penjualan['tanggal'].dt.date
    penjualan_harian = df_penjualan.groupby('tanggal_hari')['total_harga'].sum().reset_index()

    sns.set_theme(style="whitegrid")
    plt.figure(figsize=(12, 6))
    plt.plot(penjualan_harian['tanggal_hari'], penjualan_harian['total_harga'], marker='o')
    plt.title('Trend Penjualan Harian')
    plt.xlabel('Tanggal')
    plt.ylabel('Total Penjualan (Rp)')
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.savefig('trend_penjualan.png', dpi=300, bbox_inches='tight')
    plt.close()
    return penjualan_harian

if __name__ == "__main__":
    conn = hubungkan_db()
    df_stok = analisis_stok_rendah(conn)
    df_penjualan = analisis_penjualan(conn)
    
    print("\n" + "="*50)
    print("PRODUK DENGAN STOK RENDAH (Perlu Restock)")
    print("="*50)
    print(df_stok.to_string(index=False) if not df_stok.empty else "Tidak ada produk dengan stok rendah")
    
    print("\n" + "="*50)
    print("RIWAYAT PENJUALAN TERBARU")
    print("="*50)
    print(df_penjualan.to_string(index=False) if not df_penjualan.empty else "Belum ada riwayat penjualan")
    
    if not df_penjualan.empty:
        visualisasi_penjualan(df_penjualan)
    
    conn.close()
