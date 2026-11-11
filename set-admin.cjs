/**
 * One-off fix for the first admin account. Run in the backend folder:
 *   node set-admin.cjs
 * Uses MONGODB_URI, ADMIN_EMAIL and ADMIN_PASSWORD from the .env file.
 * Updates the first admin found in the database (email, password), and clears any lock.
 * If no admin exists, run `npm run seed` instead.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

(async () => {
  const uri = process.env.MONGODB_URI;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!uri || !email || !password) throw new Error("MONGODB_URI, ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  await mongoose.connect(uri);
  const admins = mongoose.connection.db.collection("admins");
  const admin = await admins.findOne({});
  if (!admin) {
    console.log("No admin found. Run: npm run seed");
  } else {
    await admins.updateOne(
      { _id: admin._id },
      { $set: { email, passwordHash: await bcrypt.hash(password, 12), failedLogins: [], lockedUntil: null } },
    );
    console.log("Admin updated to", email);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
