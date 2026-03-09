import { notFound } from "next/navigation";

import { DashboardPage } from "../dashboard-page";

/** ISR: revalidate every 60 seconds for popular stocks */
export const revalidate = 60;

/** Pre-render popular stock pages at build time */
export async function generateStaticParams() {
  return [
    { stockCode: "005930" }, // Samsung Electronics
    { stockCode: "000660" }, // SK Hynix
    { stockCode: "373220" }, // LG Energy Solution
    { stockCode: "005380" }, // Hyundai Motor
    { stockCode: "035420" }, // NAVER
    { stockCode: "035720" }, // Kakao
    { stockCode: "051910" }, // LG Chem
    { stockCode: "006400" }, // Samsung SDI
    { stockCode: "005490" }, // POSCO
    { stockCode: "068270" }, // Celltrion
  ];
}

type StockCodePageProps = {
  params: Promise<{
    stockCode: string;
  }>;
};

export default async function StockCodePage({ params }: StockCodePageProps) {
  const { stockCode } = await params;

  if (!/^\d{6}$/.test(stockCode)) {
    notFound();
  }

  return <DashboardPage initialStockCode={stockCode} />;
}
