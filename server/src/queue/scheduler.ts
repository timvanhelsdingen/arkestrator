import type { Job } from "@arkestrator/protocol";
import type { JobsRepo } from "../db/jobs.repo.js";

export class Scheduler {
  constructor(private jobsRepo: JobsRepo) {}

  pickNext(): Job | null {
    return this.jobsRepo.pickNext();
  }

  /** Pick next job, respecting worker targeting.
   *  Jobs with targetWorkerName are only returned when workerName matches. */
  pickNextForWorker(workerName: string): Job | null {
    return this.jobsRepo.pickNextForWorker(workerName);
  }
}
