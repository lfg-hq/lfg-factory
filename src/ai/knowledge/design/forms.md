# Forms

## When to Use This

Use these patterns when building any user input form: login/signup flows, settings pages, multi-step wizards, data entry screens. These patterns handle validation, error display, loading states, and accessibility out of the box.

## Quick Start

### Dependencies

```bash
npm install react-hook-form zod @hookform/resolvers
```

### Key Principles

- Always use `react-hook-form` for performance — it avoids re-renders on every keystroke
- Always pair with `zod` for schema validation via `@hookform/resolvers/zod`
- Display errors inline, immediately below the relevant field
- Disable the submit button while submitting, show a spinner
- Use `aria-describedby` to link error messages to their inputs for screen readers
- Never reset errors on submit — let the user see what failed

## Patterns

### 1. Basic Form with Zod Validation

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
});

type FormValues = z.infer<typeof schema>;

export function LoginForm() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormValues) => {
    await new Promise((r) => setTimeout(r, 1500)); // simulate API call
    console.log(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-5 w-full max-w-md"
      noValidate
    >
      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm font-medium text-gray-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          aria-describedby={errors.email ? "email-error" : undefined}
          className={`w-full rounded-lg border px-3 py-2 text-sm shadow-sm outline-none transition
            focus:ring-2 focus:ring-blue-500
            ${errors.email ? "border-red-500 bg-red-50" : "border-gray-300 bg-white"}`}
          {...register("email")}
        />
        {errors.email && (
          <p id="email-error" role="alert" className="text-xs text-red-600 mt-1">
            {errors.email.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm font-medium text-gray-700">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-describedby={errors.password ? "password-error" : undefined}
          className={`w-full rounded-lg border px-3 py-2 text-sm shadow-sm outline-none transition
            focus:ring-2 focus:ring-blue-500
            ${errors.password ? "border-red-500 bg-red-50" : "border-gray-300 bg-white"}`}
          {...register("password")}
        />
        {errors.password && (
          <p id="password-error" role="alert" className="text-xs text-red-600 mt-1">
            {errors.password.message}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5
          text-sm font-semibold text-white shadow-sm transition
          hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
          disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting && (
          <svg
            className="h-4 w-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            />
          </svg>
        )}
        {isSubmitting ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
```

### 2. Select, Checkbox, and Radio Inputs

```tsx
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({
  role: z.string().min(1, "Please select a role"),
  plan: z.enum(["free", "pro", "enterprise"], {
    errorMap: () => ({ message: "Please choose a plan" }),
  }),
  agreeTerms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the terms" }),
  }),
  notifications: z.array(z.string()).min(1, "Select at least one notification type"),
});

type FormValues = z.infer<typeof schema>;

const ROLES = ["Developer", "Designer", "Product Manager", "Marketing"];
const NOTIFICATION_OPTIONS = ["Email", "SMS", "Push", "Slack"];

export function PreferencesForm() {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { notifications: [] },
  });

  return (
    <form onSubmit={handleSubmit(console.log)} className="space-y-6 max-w-lg">
      {/* Native Select */}
      <div className="space-y-1">
        <label htmlFor="role" className="block text-sm font-medium text-gray-700">
          Role
        </label>
        <select
          id="role"
          className={`w-full rounded-lg border px-3 py-2 text-sm bg-white shadow-sm outline-none
            focus:ring-2 focus:ring-blue-500
            ${errors.role ? "border-red-500" : "border-gray-300"}`}
          {...register("role")}
        >
          <option value="">Select a role...</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        {errors.role && (
          <p role="alert" className="text-xs text-red-600">{errors.role.message}</p>
        )}
      </div>

      {/* Radio Group */}
      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 mb-2">Plan</legend>
        <div className="flex gap-4">
          {(["free", "pro", "enterprise"] as const).map((plan) => (
            <label
              key={plan}
              className="flex items-center gap-2 cursor-pointer text-sm text-gray-700"
            >
              <input
                type="radio"
                value={plan}
                className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                {...register("plan")}
              />
              <span className="capitalize">{plan}</span>
            </label>
          ))}
        </div>
        {errors.plan && (
          <p role="alert" className="text-xs text-red-600 mt-1">{errors.plan.message}</p>
        )}
      </fieldset>

      {/* Checkbox Group */}
      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 mb-2">
          Notifications
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {NOTIFICATION_OPTIONS.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 cursor-pointer text-sm text-gray-700"
            >
              <input
                type="checkbox"
                value={opt}
                className="h-4 w-4 rounded text-blue-600 border-gray-300 focus:ring-blue-500"
                {...register("notifications")}
              />
              {opt}
            </label>
          ))}
        </div>
        {errors.notifications && (
          <p role="alert" className="text-xs text-red-600 mt-1">
            {errors.notifications.message}
          </p>
        )}
      </fieldset>

      {/* Single Checkbox */}
      <div className="space-y-1">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded text-blue-600 border-gray-300 focus:ring-blue-500"
            {...register("agreeTerms")}
          />
          <span className="text-sm text-gray-600">
            I agree to the{" "}
            <a href="/terms" className="text-blue-600 underline">Terms of Service</a>
            {" "}and{" "}
            <a href="/privacy" className="text-blue-600 underline">Privacy Policy</a>
          </span>
        </label>
        {errors.agreeTerms && (
          <p role="alert" className="text-xs text-red-600">{errors.agreeTerms.message}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white
          hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition"
      >
        Save Preferences
      </button>
    </form>
  );
}
```

### 3. Multi-Step Wizard Form

```tsx
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

// Step schemas
const step1Schema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email"),
});

const step2Schema = z.object({
  company: z.string().min(1, "Company is required"),
  role: z.string().min(1, "Role is required"),
  teamSize: z.string().min(1, "Team size is required"),
});

const step3Schema = z.object({
  password: z.string().min(8, "At least 8 characters"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type Step1 = z.infer<typeof step1Schema>;
type Step2 = z.infer<typeof step2Schema>;
type Step3 = z.infer<typeof step3Schema>;

const STEPS = ["Personal Info", "Company", "Security"];

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-semibold transition
              ${i < current
                ? "bg-blue-600 text-white"
                : i === current
                ? "bg-blue-600 text-white ring-4 ring-blue-100"
                : "bg-gray-200 text-gray-500"
              }`}
          >
            {i < current ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              i + 1
            )}
          </div>
          {i < total - 1 && (
            <div className={`h-0.5 w-12 transition ${i < current ? "bg-blue-600" : "bg-gray-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export function SignupWizard() {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Partial<Step1 & Step2 & Step3>>({});

  const form1 = useForm<Step1>({ resolver: zodResolver(step1Schema), defaultValues: formData });
  const form2 = useForm<Step2>({ resolver: zodResolver(step2Schema), defaultValues: formData });
  const form3 = useForm<Step3>({ resolver: zodResolver(step3Schema) });

  const handleStep1 = form1.handleSubmit((data) => {
    setFormData((prev) => ({ ...prev, ...data }));
    setStep(1);
  });

  const handleStep2 = form2.handleSubmit((data) => {
    setFormData((prev) => ({ ...prev, ...data }));
    setStep(2);
  });

  const handleStep3 = form3.handleSubmit(async (data) => {
    const final = { ...formData, ...data };
    console.log("Final submission:", final);
    // await createAccount(final)
  });

  return (
    <div className="max-w-lg mx-auto p-8 bg-white rounded-2xl shadow-lg">
      <StepIndicator current={step} total={3} />

      <h2 className="text-xl font-bold text-gray-900 mb-1">{STEPS[step]}</h2>
      <p className="text-sm text-gray-500 mb-6">Step {step + 1} of {STEPS.length}</p>

      {/* Step 1 */}
      {step === 0 && (
        <form onSubmit={handleStep1} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {(["firstName", "lastName"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <label className="block text-sm font-medium text-gray-700 capitalize">
                  {field === "firstName" ? "First Name" : "Last Name"}
                </label>
                <input
                  className={`w-full rounded-lg border px-3 py-2 text-sm outline-none
                    focus:ring-2 focus:ring-blue-500
                    ${form1.formState.errors[field] ? "border-red-500" : "border-gray-300"}`}
                  {...form1.register(field)}
                />
                {form1.formState.errors[field] && (
                  <p className="text-xs text-red-600">{form1.formState.errors[field]?.message}</p>
                )}
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              className={`w-full rounded-lg border px-3 py-2 text-sm outline-none
                focus:ring-2 focus:ring-blue-500
                ${form1.formState.errors.email ? "border-red-500" : "border-gray-300"}`}
              {...form1.register("email")}
            />
            {form1.formState.errors.email && (
              <p className="text-xs text-red-600">{form1.formState.errors.email.message}</p>
            )}
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
            >
              Continue
            </button>
          </div>
        </form>
      )}

      {/* Step 2 */}
      {step === 1 && (
        <form onSubmit={handleStep2} className="space-y-4">
          {(["company", "role", "teamSize"] as const).map((field) => (
            <div key={field} className="space-y-1">
              <label className="block text-sm font-medium text-gray-700 capitalize">
                {field === "teamSize" ? "Team Size" : field.charAt(0).toUpperCase() + field.slice(1)}
              </label>
              <input
                className={`w-full rounded-lg border px-3 py-2 text-sm outline-none
                  focus:ring-2 focus:ring-blue-500
                  ${form2.formState.errors[field] ? "border-red-500" : "border-gray-300"}`}
                {...form2.register(field)}
              />
              {form2.formState.errors[field] && (
                <p className="text-xs text-red-600">{form2.formState.errors[field]?.message}</p>
              )}
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(0)}
              className="rounded-lg border border-gray-300 px-6 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
            >
              Back
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
            >
              Continue
            </button>
          </div>
        </form>
      )}

      {/* Step 3 */}
      {step === 2 && (
        <form onSubmit={handleStep3} className="space-y-4">
          {(["password", "confirmPassword"] as const).map((field) => (
            <div key={field} className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">
                {field === "confirmPassword" ? "Confirm Password" : "Password"}
              </label>
              <input
                type="password"
                className={`w-full rounded-lg border px-3 py-2 text-sm outline-none
                  focus:ring-2 focus:ring-blue-500
                  ${form3.formState.errors[field] ? "border-red-500" : "border-gray-300"}`}
                {...form3.register(field)}
              />
              {form3.formState.errors[field] && (
                <p className="text-xs text-red-600">{form3.formState.errors[field]?.message}</p>
              )}
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-lg border border-gray-300 px-6 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={form3.formState.isSubmitting}
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white
                hover:bg-blue-700 disabled:opacity-60 transition"
            >
              Create Account
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
```

### 4. File Input with Preview

```tsx
import { useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  avatar: z
    .custom<FileList>()
    .refine((files) => files?.length > 0, "Please select a file")
    .refine(
      (files) => files?.[0]?.size <= MAX_FILE_SIZE,
      "File must be less than 5MB"
    )
    .refine(
      (files) => ACCEPTED_TYPES.includes(files?.[0]?.type),
      "Only JPEG, PNG, and WebP are allowed"
    ),
});

type FormValues = z.infer<typeof schema>;

export function ProfileForm() {
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const handleFileChange = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      setValue("avatar", files, { shouldValidate: true });
      const reader = new FileReader();
      reader.onload = (e) => setPreview(e.target?.result as string);
      reader.readAsDataURL(file);
    },
    [setValue]
  );

  const fileInputProps = register("avatar", {
    onChange: (e) => handleFileChange(e.target.files),
  });

  return (
    <form onSubmit={handleSubmit(console.log)} className="space-y-5 max-w-md">
      <div className="space-y-1">
        <label className="block text-sm font-medium text-gray-700">Name</label>
        <input
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          {...register("name")}
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">Avatar</label>

        {/* Drop zone */}
        <label
          onDragEnter={() => setIsDragging(true)}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFileChange(e.dataTransfer.files);
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed
            cursor-pointer transition p-8
            ${isDragging
              ? "border-blue-500 bg-blue-50"
              : errors.avatar
              ? "border-red-400 bg-red-50"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
            }`}
        >
          {preview ? (
            <img
              src={preview}
              alt="Preview"
              className="h-24 w-24 rounded-full object-cover ring-4 ring-white shadow"
            />
          ) : (
            <>
              <div className="h-12 w-12 rounded-full bg-gray-200 flex items-center justify-center">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="text-center">
                <span className="text-sm font-medium text-blue-600">Click to upload</span>
                <span className="text-sm text-gray-500"> or drag and drop</span>
                <p className="text-xs text-gray-400 mt-1">PNG, JPG, WebP up to 5MB</p>
              </div>
            </>
          )}
          <input
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            className="sr-only"
            {...fileInputProps}
          />
        </label>

        {errors.avatar && (
          <p role="alert" className="text-xs text-red-600">{errors.avatar.message as string}</p>
        )}

        {preview && (
          <button
            type="button"
            onClick={() => {
              setPreview(null);
              setValue("avatar", undefined as unknown as FileList, { shouldValidate: false });
            }}
            className="text-xs text-red-500 hover:text-red-700 underline"
          >
            Remove image
          </button>
        )}
      </div>

      <button
        type="submit"
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition"
      >
        Save Profile
      </button>
    </form>
  );
}
```

### 5. Form with Server Error Handling

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";

const schema = z.object({
  username: z.string().min(3, "At least 3 characters").max(20, "Max 20 characters")
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers, and underscores only"),
  bio: z.string().max(160, "Max 160 characters").optional(),
});

type FormValues = z.infer<typeof schema>;

// Simulated server errors
async function updateProfile(data: FormValues): Promise<{ error?: Record<string, string> }> {
  await new Promise((r) => setTimeout(r, 1000));
  if (data.username === "taken") {
    return { error: { username: "This username is already taken" } };
  }
  return {};
}

export function UsernameForm() {
  const [successMessage, setSuccessMessage] = useState("");
  const [charCount, setCharCount] = useState(0);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    setSuccessMessage("");
    const result = await updateProfile(data);
    if (result.error) {
      // Map server errors back to form fields
      Object.entries(result.error).forEach(([field, message]) => {
        setError(field as keyof FormValues, { type: "server", message });
      });
      return;
    }
    setSuccessMessage("Profile updated successfully!");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 max-w-md">
      {successMessage && (
        <div
          role="status"
          className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 flex items-center gap-2"
        >
          <svg className="h-4 w-4 text-green-600 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <p className="text-sm text-green-700 font-medium">{successMessage}</p>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="username" className="block text-sm font-medium text-gray-700">
          Username
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">@</span>
          <input
            id="username"
            className={`w-full rounded-lg border pl-7 pr-3 py-2 text-sm outline-none
              focus:ring-2 focus:ring-blue-500
              ${errors.username ? "border-red-500 bg-red-50" : "border-gray-300"}`}
            {...register("username")}
          />
        </div>
        {errors.username && (
          <p role="alert" className="text-xs text-red-600">{errors.username.message}</p>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between">
          <label htmlFor="bio" className="block text-sm font-medium text-gray-700">Bio</label>
          <span className={`text-xs ${charCount > 140 ? "text-red-500" : "text-gray-400"}`}>
            {charCount}/160
          </span>
        </div>
        <textarea
          id="bio"
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none
            focus:ring-2 focus:ring-blue-500 resize-none"
          {...register("bio", {
            onChange: (e) => setCharCount(e.target.value.length),
          })}
        />
        {errors.bio && (
          <p role="alert" className="text-xs text-red-600">{errors.bio.message}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting || !isDirty}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white
          hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {isSubmitting ? "Saving..." : "Save Changes"}
      </button>
    </form>
  );
}
```

## Common Mistakes

- **Do not use `useState` for form values** — use `react-hook-form`'s `register` and `watch` instead; direct state causes re-renders on every keystroke
- **Do not validate only on submit** — use `mode: "onTouched"` or `mode: "onChange"` in `useForm` to surface errors as the user types
- **Do not show all errors at the top** — display errors inline, directly below the field they relate to; this reduces cognitive load
- **Do not forget `noValidate` on `<form>`** — this disables native browser validation, which conflicts with your custom schema validation
- **Do not use generic error text** — write specific, actionable error messages ("Must be at least 8 characters" not "Invalid input")
- **Do not make the submit button always disabled** — only disable it while `isSubmitting` is true; disabling on invalid prevents users from seeing all validation errors at once
- **Do not skip `aria-describedby`** — screen readers need this link to announce field errors when focus moves to the input

## Framework-Specific Notes

### Next.js

- Mark form components with `"use client"` — `react-hook-form` uses browser APIs and will not work as a Server Component
- For Server Actions, call `action.bind(null, data)` or use the `action` prop on `<form>` with `useFormState` from `react-dom`
- Avoid `next/navigation`'s `router.push()` inside `handleSubmit` before the async call completes — await first

### React + Vite

- No special config needed; `react-hook-form` and `zod` work out of the box
- For file uploads, remember to set `encType="multipart/form-data"` if submitting natively, or use `FormData` in your fetch call
- Use `import.meta.env.VITE_API_URL` for API base URLs in submit handlers
