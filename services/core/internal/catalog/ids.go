package catalog

// ProductID is a family identifier. It is never a cart, hold, or order line.
type ProductID string

// SKUID is the sellable unit used on cart lines, inventory, holds, and orders.
type SKUID string
