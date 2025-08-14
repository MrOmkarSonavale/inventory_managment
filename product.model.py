@app.route('/api/products', methods=['POST']) 
def create_product(): 
    data = request.json 
     
    # Create new product 
    product = Product( 
        name=data['name'], 
        sku=data['sku'], 
        price=data['price'], 
        warehouse_id=data['warehouse_id'] 
    ) 
     
    db.session.add(product) 
    db.session.commit() 
     
    # Update inventory count 
    inventory = Inventory( 
        product_id=product.id, 
        warehouse_id=data['warehouse_id'], 
        quantity=data['initial_quantity'] 
    ) 
     
    db.session.add(inventory) 
    db.session.commit() 
     
    return {"message": "Product created", "product_id": product.id} 

# problem  in this code 

# 1st problem
# data = request.json
# the problem we are not properly handling the case when the request body is empty or missing required fields. We should add validation to ensure that all necessary data is provided before attempting to create a product.

#2nd prblem
#   product = Product( 
#         name=data['name'], 
#         sku=data['sku'], 
#         price=data['price'], 
#         warehouse_id=data['warehouse_id'] 
#     ) 
#  price is likely to be a float, so we should validate that it is a number and not negative.
# SKU uniqueness is not enforced here — could insert duplicates.
# Directly linking warehouse_id to Product assumes each product belongs to only one warehouse — but in our porblem we have 1 to many relastionship.


#3rd problem
#   db.session.add(product) 
#   db.session.commit()
# Commits the product before adding inventory. If the next part fails, you have a product without inventory

# 4th problem
#     inventory = Inventory( 
#         product_id=product.id, 
#         warehouse_id=data['warehouse_id'], 
#         quantity=data['initial_quantity'] 
#  )
# No check if inventory for (product_id, warehouse_id) already exists (could create duplicates).
# initial_quantity not validated (could be negative or non-integer

# 5th problem
#    db.session.add(inventory) 
#     db.session.commit()
# This is the second commit — means two separate transactions.
# If the first commit succeeded but this one fails, the DB will be in an inconsistent state.

# 6th problem
#   return {"message": "Product created", "product_id": product.id}
# Always returns success, even if errors occurred earlier (no try/except).
# Should return 201 Created instead of 200 OK.

from flask import request, jsonify
from decimal import Decimal, InvalidOperation
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func

@app.route('/api/products', methods=['POST'])
def create_product():
    data = request.get_json(silent=True) or {}

    # 1. Validate required fields
    required = ['name', 'sku', 'price', 'warehouse_id']
    missing = [f for f in required if f not in data]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

    # 2. Validate price as Decimal
    try:
        price = Decimal(str(data['price']))
        if price < 0:
            return jsonify({"error": "Price must be >= 0"}), 400
    except (InvalidOperation, TypeError):
        return jsonify({"error": "Price must be a decimal number"}), 400

    # 3. Validate initial quantity
    initial_qty = data.get('initial_quantity', 0)
    if not isinstance(initial_qty, (int, float)) or initial_qty < 0:
        return jsonify({"error": "Initial quantity must be a non-negative number"}), 400

    warehouse_id = data['warehouse_id']

    try:
        # 4. Single transaction for both product and inventory
        with db.session.begin():
            # Check SKU uniqueness
            existing = db.session.query(Product).filter(
                func.lower(Product.sku) == data['sku'].strip().lower()
            ).first()
            if existing:
                return jsonify({"error": "SKU already exists"}), 409

            # Create product
            product = Product(
                name=data['name'].strip(),
                sku=data['sku'].strip(),
                price=price
            )
            db.session.add(product)
            db.session.flush()  # Get product.id

            # Check if inventory for this warehouse already exists
            inv = db.session.query(Inventory).filter_by(
                product_id=product.id,
                warehouse_id=warehouse_id
            ).first()

            if inv:
                inv.quantity += initial_qty
            else:
                inv = Inventory(
                    product_id=product.id,
                    warehouse_id=warehouse_id,
                    quantity=initial_qty
                )
                db.session.add(inv)

            # Optionally create an inventory ledger entry
            if initial_qty > 0:
                ledger = InventoryLedger(
                    product_id=product.id,
                    warehouse_id=warehouse_id,
                    quantity_delta=initial_qty,
                    reason='initial_stock'
                )
                db.session.add(ledger)

        return jsonify({"message": "Product created", "product_id": product.id}), 201

    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "Database integrity error — possible duplicate SKU"}), 409
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500
