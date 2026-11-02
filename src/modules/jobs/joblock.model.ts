import { Schema, model } from "mongoose";

const lockSchema = new Schema({ name: { type: String, required: true, unique: true }, until: { type: Date, default: null } });
export const JobLock = model("JobLock", lockSchema, "job_locks");
