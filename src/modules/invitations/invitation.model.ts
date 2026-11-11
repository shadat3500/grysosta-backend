import { Schema, model, type InferSchemaType } from "mongoose";

/** One "Send batch" action on the Purchase Invitations page (history list). */
const invitationBatchSchema = new Schema(
  {
    groups: { type: [String], default: [] },
    batchSize: { type: Number, required: true },
    invited: { type: Number, required: true },
    byGroup: { type: Schema.Types.Mixed, default: {} },
    remaining: { type: Number, default: 0 },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);
invitationBatchSchema.index({ createdAt: -1 });

export type InvitationBatchDoc = InferSchemaType<typeof invitationBatchSchema>;
export const InvitationBatch = model("InvitationBatch", invitationBatchSchema, "invitation_batches");
