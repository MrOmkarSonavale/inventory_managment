// routes/alerts.js
import { Router } from "express";
import { Pool } from "pg";

const alertsRouter = Router();

export default function initAlertsRoutes(db: Pool) {
  alertsRouter.get(
    "/api/companies/:companyId/alerts/low-stock",
    async (req, res) => {
      const companyId = parseInt(req.params.companyId, 10);
      const daysWindow = parseInt(req.query.days as string, 10) || 30;

      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ error: "Invalid company_id" });
      }

      if (daysWindow < 1 || daysWindow > 365) {
        return res
          .status(400)
          .json({ error: "Days parameter must be between 1 and 365" });
      }

      const sql = `
      WITH sales_window AS (
        SELECT soi.product_id,
               SUM(soi.quantity) AS total_sold
        FROM sales_order_items soi
        JOIN sales_orders so ON so.id = soi.sales_order_id
        WHERE so.company_id = $1
          AND so.created_at >= now() - ($2 || ' days')::interval
        GROUP BY soi.product_id
      ),
      threshold_lookup AS (
        SELECT i.product_id,
               i.warehouse_id,
               COALESCE(i.reorder_point, pt.default_low_stock_threshold, 0) AS threshold
        FROM inventories i
        JOIN warehouses w ON w.id = i.warehouse_id
        JOIN products p ON p.id = i.product_id
        LEFT JOIN product_types pt ON pt.id = p.product_type_id
        WHERE w.company_id = $1
      ),
      base_data AS (
        SELECT p.id AS product_id,
               p.name AS product_name,
               p.sku,
               w.id AS warehouse_id,
               w.name AS warehouse_name,
               i.quantity AS current_stock,
               t.threshold,
               sw.total_sold
        FROM inventories i
        JOIN warehouses w ON w.id = i.warehouse_id
        JOIN products p ON p.id = i.product_id
        JOIN threshold_lookup t
          ON t.product_id = i.product_id AND t.warehouse_id = i.warehouse_id
        LEFT JOIN sales_window sw ON sw.product_id = p.id
      ),
      filtered AS (
        SELECT * FROM base_data
        WHERE COALESCE(total_sold, 0) > 0
          AND current_stock < threshold
      ),
      sales_rates AS (
        SELECT product_id,
               (total_sold::numeric / $2::numeric) AS avg_daily_sales
        FROM sales_window
      ),
      supplier_ranked AS (
        SELECT sp.product_id,
               sp.supplier_id,
               s.name,
               s.contact_email,
               ROW_NUMBER() OVER (
                 PARTITION BY sp.product_id
                 ORDER BY CASE WHEN sp.is_primary THEN 0 ELSE 1 END,
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
             f.current_stock::float,
             f.threshold,
             CASE
               WHEN sr.avg_daily_sales IS NULL OR sr.avg_daily_sales = 0 THEN NULL
               ELSE ROUND(f.current_stock / sr.avg_daily_sales, 2)
             END AS days_until_stockout,
             jsonb_build_object(
               'id', sup.supplier_id,
               'name', sup.name,
               'contact_email', sup.contact_email
             ) AS supplier
      FROM filtered f
      LEFT JOIN sales_rates sr ON sr.product_id = f.product_id
      LEFT JOIN supplier_ranked sup ON sup.product_id = f.product_id AND sup.rn = 1
      ORDER BY (f.threshold - f.current_stock) DESC, f.product_name;
    `;

      try {
        const { rows } = await db.query(sql, [companyId, daysWindow]);
        res.json({
          alerts: rows,
          total_alerts: rows.length,
        });
      } catch (err) {
        console.error("Error fetching low-stock alerts:", err);
        res.status(500).json({ error: "Failed to fetch alerts" });
      }
    }
  );

  return alertsRouter;
}
