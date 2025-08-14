// src/routes/alerts.ts
import { Router, Request, Response } from "express";
import { Pool } from "pg";

const router = Router();

export default (pool: Pool) => {
  router.get(
    "/api/companies/:companyId/alerts/low-stock",
    async (req: Request, res: Response) => {
      const companyId = Number(req.params.companyId);
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30)); // default 30 days

      if (!Number.isFinite(companyId)) {
        return res.status(400).json({ error: "Invalid companyId" });
      }

      try {
        const client = await pool.connect();
        try {
          const { rows } = await client.query(
            `
            WITH recent_sales AS (
              SELECT soi.product_id,
                     SUM(soi.quantity) AS sold_qty
              FROM sales_order_items soi
              JOIN sales_orders so ON so.id = soi.sales_order_id
              WHERE so.company_id = $1
                AND so.created_at >= now() - ($2 || ' days')::interval
              GROUP BY soi.product_id
            ),
            thresholds AS (
              SELECT i.product_id,
                     i.warehouse_id,
                     COALESCE(i.reorder_point, pt.default_low_stock_threshold, 0) AS threshold
              FROM inventories i
              JOIN warehouses w ON w.id = i.warehouse_id AND w.company_id = $1
              JOIN products p ON p.id = i.product_id
              LEFT JOIN product_types pt ON pt.name = p.product_type
            ),
            base AS (
              SELECT p.id AS product_id,
                     p.name AS product_name,
                     p.sku,
                     w.id AS warehouse_id,
                     w.name AS warehouse_name,
                     i.quantity AS current_stock,
                     t.threshold,
                     rs.sold_qty
              FROM thresholds t
              JOIN inventories i ON i.product_id = t.product_id AND i.warehouse_id = t.warehouse_id
              JOIN warehouses w ON w.id = i.warehouse_id
              JOIN products p ON p.id = i.product_id
              LEFT JOIN recent_sales rs ON rs.product_id = p.id
            ),
            filtered AS (
              SELECT * FROM base
              WHERE COALESCE(sold_qty, 0) > 0  -- recent sales activity
                AND current_stock < threshold  -- low stock
            ),
            sales_rate AS (
              SELECT product_id,
                     (COALESCE(sold_qty, 0)::numeric / $2::numeric) AS avg_daily_sales
              FROM recent_sales
            ),
            supplier_choice AS (
              SELECT sp.product_id,
                     sp.supplier_id,
                     s.name,
                     s.contact_email,
                     ROW_NUMBER() OVER (
                       PARTITION BY sp.product_id
                       ORDER BY (CASE WHEN sp.is_primary THEN 0 ELSE 1 END),
                                sp.lead_time_days NULLS LAST
                     ) AS rn
              FROM supplier_products sp
              JOIN suppliers s ON s.id = sp.supplier_id
            )
            SELECT f.product_id,
                   f.product_name,
                   f.sku,
                   f.warehouse_id,
                   f.warehouse_name,
                   f.current_stock::float AS current_stock,
                   f.threshold,
                   CASE 
                     WHEN COALESCE(sr.avg_daily_sales, 0) = 0 THEN NULL
                     ELSE ROUND(f.current_stock / sr.avg_daily_sales, 2)
                   END AS days_until_stockout,
                   jsonb_build_object(
                     'id', sc.supplier_id,
                     'name', sc.name,
                     'contact_email', sc.contact_email
                   ) AS supplier
            FROM filtered f
            LEFT JOIN sales_rate sr ON sr.product_id = f.product_id
            LEFT JOIN supplier_choice sc 
              ON sc.product_id = f.product_id AND sc.rn = 1
            ORDER BY (f.threshold - f.current_stock) DESC, f.product_name
            `,
            [companyId, days]
          );

          res.json({ alerts: rows, total_alerts: rows.length });
        } finally {
          client.release();
        }
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  return router;
};
