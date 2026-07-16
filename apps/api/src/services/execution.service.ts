import prisma from "../lib/prisma.js";
import { executionQueue } from "../queues/execution.queue.js";

export const createExecution = async (
  userId: string,
  language: string,
  code: string
) => {

  const execution = await prisma.execution.create({
  data: {
    language,
    code,
    userId,
    status: "PENDING",
  },
});



await executionQueue.add(
  "execute-code",
  {
    executionId: execution.id,
  }
);



return execution;




};

export async function getExecution(id: string) {
  return prisma.execution.findUnique({
    where: { id }
  });
}

export async function getUserExecutions(userId: string) {
  return prisma.execution.findMany({
    where: {
      userId
    },
    orderBy: {
      createdAt: "desc"
    }
  });
}

export async function deleteExecution(id: string) {
  return prisma.execution.delete({
    where: { id }
  });
};