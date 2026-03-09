import { notFound } from "next/navigation";

import { DashboardPage } from "../dashboard-page";

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
