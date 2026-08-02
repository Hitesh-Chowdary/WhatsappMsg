import React, { useState, useEffect, useRef, useCallback } from 'react';
import FlowBuilder from './components/FlowBuilder';

const API_BASE = window.location.port === "5173" ? "http://localhost:8000" : "";
const RECORDS_PER_PAGE = 15;

function App() {
  // Auth State
  const [token, setToken] = useState(localStorage.getItem('jwt_token') || null);
  const [currentUser, setCurrentUser] = useState(() => {
    const cached = localStorage.getItem('currentUserObj');
    try {
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Change Password State
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changePasswordError, setChangePasswordError] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  // Stats State
  const [stats, setStats] = useState({
    total: 0,
    sent: 0,
    unsent: 0,
    read: 0,
    failed: 0,
    interested: 0,
    not_interested: 0
  });

  // Authenticated Fetch Wrapper
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
    
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        if (localStorage.getItem('jwt_token')) {
          localStorage.removeItem('jwt_token');
          localStorage.removeItem('currentUser');
          setToken(null);
          setCurrentUser(null);
          triggerToast("Session expired or unauthorized. Please log in.", "error");
        }
      }
      return res;
    } catch (err) {
      console.error("API request failed:", err);
      throw err;
    }
  }, [token]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword.trim()) {
      setLoginError("Please enter both username and password.");
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername,
          password: loginPassword
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Invalid credentials.");
      }
      
      localStorage.setItem('jwt_token', data.access_token);
      if (data.user) {
        localStorage.setItem('currentUserObj', JSON.stringify(data.user));
        setCurrentUser(data.user);
        const targetView = data.user.role === 'counselor' ? 'chat' : 'outreach';
        setActiveView(targetView);
        const targetPath = getPathFromView(targetView, data.user.role);
        window.history.pushState(null, '', targetPath);
      }
      setToken(data.access_token);
      triggerToast("Logged in successfully.", "success");
    } catch (err) {
      setLoginError(err.message || "Failed to connect to the authentication server.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentUserObj');
    localStorage.removeItem('activeView');
    localStorage.removeItem('activeChatRecordId');
    setToken(null);
    setCurrentUser(null);
    setLoginUsername('');
    setLoginPassword('');
    window.history.pushState(null, '', '/login');
    triggerToast("Logged out successfully.", "info");
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!oldPassword || !newPassword) {
      setChangePasswordError('Please enter both current and new passwords.');
      return;
    }
    setChangePasswordLoading(true);
    setChangePasswordError('');
    try {
      const res = await authFetch(`${API_BASE}/api/v1/admin/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
      });
      const data = await res.json();
      if (res.ok && data.status === 'success') {
        triggerToast('Password updated successfully!', 'success');
        setIsChangePasswordOpen(false);
        setOldPassword('');
        setNewPassword('');
      } else {
        setChangePasswordError(data.detail || data.message || 'Failed to update password.');
      }
    } catch (err) {
      setChangePasswordError(err.message || 'Failed to update password.');
    } finally {
      setChangePasswordLoading(false);
    }
  };

  // Records and Grid State
  const [records, setRecords] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [dispatchFilter, setDispatchFilter] = useState('all'); // 'all', 'unsent', 'sent', 'failed'
  const [deliveryFilter, setDeliveryFilter] = useState('all'); // 'all', 'undelivered', 'delivered'
  const [readFilter, setReadFilter] = useState('all'); // 'all', 'not_read', 'read'
  const [responseFilter, setResponseFilter] = useState('all'); // 'all', 'no_response', 'interested', 'not_interested'
  const [search, setSearch] = useState('');
  const [gridLoading, setGridLoading] = useState(true);
  const [gridError, setGridError] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [pipelineTagFilter, setPipelineTagFilter] = useState('all');
  const [pendingNotesFilter, setPendingNotesFilter] = useState(false);
  const [branches, setBranches] = useState([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState([]);

  // AI Brochure Knowledge Base State
  const [brochures, setBrochures] = useState([]);
  const [brochureLoading, setBrochureLoading] = useState(false);
  const [uploadingBrochure, setUploadingBrochure] = useState(false);
  const [brochureTitle, setBrochureTitle] = useState('');
  const [selectedBrochureFile, setSelectedBrochureFile] = useState(null);
  const [selectedPreviewBrochure, setSelectedPreviewBrochure] = useState(null);

  // Website Crawler & Auto-Indexer State
  const [websitePages, setWebsitePages] = useState([]);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [maxPagesToCrawl, setMaxPagesToCrawl] = useState(25);
  const [crawlingWebsite, setCrawlingWebsite] = useState(false);
  const [selectedPreviewPage, setSelectedPreviewPage] = useState(null);

  const fetchWebsitePages = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/website/pages`);
      if (res.ok) {
        const data = await res.json();
        setWebsitePages(data);
      }
    } catch (err) {
      console.error("Failed to fetch website pages:", err);
    }
  };

  const handleCrawlWebsite = async (e) => {
    e.preventDefault();
    if (!websiteUrl.trim()) {
      triggerToast("Please enter a valid website URL (e.g. https://your-college-website.edu.in/).", "warning");
      return;
    }
    setCrawlingWebsite(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/website/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: websiteUrl.trim(), max_pages: Number(maxPagesToCrawl) || 25 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to crawl website.");
      triggerToast(`Successfully crawled & indexed ${data.pages_crawled} pages from ${data.domain}!`, "success");
      setWebsiteUrl('');
      fetchWebsitePages();
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setCrawlingWebsite(false);
    }
  };

  const handleToggleWebsitePage = async (id) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/website/pages/${id}/toggle`, {
        method: 'PATCH'
      });
      if (res.ok) {
        const data = await res.json();
        setWebsitePages(prev => prev.map(p => p.id === id ? data.page : p));
        triggerToast("Website page AI status updated.", "info");
      }
    } catch (err) {
      triggerToast("Failed to toggle page status.", "error");
    }
  };

  const handleDeleteWebsitePage = async (id) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Indexed Web Page",
      message: "Are you sure you want to remove this website page from the AI Knowledge Base?",
      onConfirm: async () => {
        try {
          const res = await authFetch(`${API_BASE}/api/v1/website/pages/${id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            setWebsitePages(prev => prev.filter(p => p.id !== id));
            triggerToast("Website page deleted.", "success");
          }
        } catch (err) {
          triggerToast("Failed to delete page.", "error");
        }
      }
    });
  };

  // Staff & Team User Management State
  const [teamUsers, setTeamUsers] = useState([]);
  const [newStaffFullName, setNewStaffFullName] = useState('');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffUsername, setNewStaffUsername] = useState('');
  const [newStaffPassword, setNewStaffPassword] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('counselor');
  const [creatingUser, setCreatingUser] = useState(false);

  const fetchCurrentUser = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/auth/me`);
      if (res.ok) {
        const u = await res.json();
        setCurrentUser(u);
        localStorage.setItem('currentUserObj', JSON.stringify(u));
        // Sync activeView with current URL pathname to prevent view jumping on refresh
        const viewFromUrl = getViewFromPath(window.location.pathname, u.role);
        if (viewFromUrl) {
          setActiveView(viewFromUrl);
        }
      }
    } catch (err) {
      console.error("Failed to fetch user profile:", err);
    }
  };

  const fetchTeamUsers = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/users`);
      if (res.ok) {
        const data = await res.json();
        setTeamUsers(data);
      }
    } catch (err) {
      console.error("Failed to fetch team users:", err);
    }
  };

  const [workloadStats, setWorkloadStats] = useState([]);

  const fetchWorkloadStats = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/users/workload`);
      if (res.ok) {
        const data = await res.json();
        setWorkloadStats(data.workload || []);
      }
    } catch (err) {
      console.error("Failed to fetch workload stats:", err);
    }
  };

  const handleCreateStaffUser = async (e) => {
    e.preventDefault();
    if (!newStaffFullName.trim() || !newStaffEmail.trim() || !newStaffUsername.trim() || !newStaffPassword.trim()) {
      triggerToast("Please fill in all staff account details.", "warning");
      return;
    }
    setCreatingUser(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: newStaffFullName.trim(),
          email: newStaffEmail.trim(),
          username: newStaffUsername.trim(),
          password: newStaffPassword.trim(),
          role: newStaffRole
        })
      });
      const data = await res.json();
      if (!res.ok) {
        let errStr = "Failed to create staff member account.";
        if (typeof data.detail === 'string') {
          errStr = data.detail;
        } else if (Array.isArray(data.detail)) {
          errStr = data.detail.map(d => d.msg || JSON.stringify(d)).join(', ');
        }
        throw new Error(errStr);
      }
      triggerToast(`Staff account created for ${data.user.full_name}!`, "success");
      setNewStaffFullName('');
      setNewStaffEmail('');
      setNewStaffUsername('');
      setNewStaffPassword('');
      setNewStaffRole('counselor');
      fetchTeamUsers();
    } catch (err) {
      triggerToast(err.message || "Error creating staff account.", "error");
    } finally {
      setCreatingUser(false);
    }
  };

  const handleToggleUserStatus = async (userId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/users/${userId}/status`, { method: "PATCH" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to update status.");
      triggerToast("User account status updated.", "info");
      fetchTeamUsers();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  const handleDeleteUser = async (userId) => {
    setConfirmModal({
      isOpen: true,
      title: "Remove Staff Member",
      message: "Are you sure you want to delete this staff account?",
      onConfirm: async () => {
        try {
          const res = await authFetch(`${API_BASE}/api/v1/users/${userId}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to delete user.");
          triggerToast("Staff account deleted.", "success");
          fetchTeamUsers();
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  const fetchBrochures = async () => {
    setBrochureLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/brochures`);
      if (res.ok) {
        const data = await res.json();
        setBrochures(data);
      }
    } catch (err) {
      console.error("Failed to fetch brochures:", err);
    } finally {
      setBrochureLoading(false);
    }
  };

  const handleUploadBrochure = async (e) => {
    e.preventDefault();
    if (!selectedBrochureFile) {
      triggerToast("Please select a brochure document file (PDF or TXT).", "warning");
      return;
    }
    if (selectedBrochureFile.size > 10 * 1024 * 1024) {
      triggerToast("File size exceeds 10 MB limit. Please upload a smaller document.", "error");
      return;
    }
    setUploadingBrochure(true);
    const formData = new FormData();
    formData.append("file", selectedBrochureFile);
    if (brochureTitle.trim()) {
      formData.append("title", brochureTitle.trim());
    }

    try {
      const res = await authFetch(`${API_BASE}/api/v1/brochures/upload`, {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to upload brochure.");
      
      if (data.brochure?.warning) {
        triggerToast(data.brochure.warning, "warning");
      } else {
        triggerToast("Brochure uploaded & indexed for AI Chatbot successfully!", "success");
      }
      setBrochureTitle('');
      setSelectedBrochureFile(null);
      fetchBrochures();
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setUploadingBrochure(false);
    }
  };

  const handleToggleBrochure = async (id) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/brochures/${id}/toggle`, {
        method: 'PATCH'
      });
      if (res.ok) {
        const data = await res.json();
        setBrochures(prev => prev.map(b => b.id === id ? data.brochure : b));
        triggerToast("Brochure AI status updated.", "info");
      }
    } catch (err) {
      triggerToast("Failed to toggle brochure status.", "error");
    }
  };

  const handleDeleteBrochure = async (id) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Brochure Document",
      message: "Are you sure you want to remove this brochure document from the AI Knowledge Base?",
      onConfirm: async () => {
        try {
          const res = await authFetch(`${API_BASE}/api/v1/brochures/${id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            setBrochures(prev => prev.filter(b => b.id !== id));
            triggerToast("Brochure document deleted.", "success");
          }
        } catch (err) {
          triggerToast("Failed to delete brochure.", "error");
        }
      }
    });
  };


  // Custom Confirm Modal State
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null
  });

  const closeConfirmModal = () => {
    setConfirmModal(prev => ({ ...prev, isOpen: false }));
  };

  const isRecordEligibleForBulk = (rec) => {
    const campaignStatus = (rec.campaign_status || '').toLowerCase();
    const deliveryStatus = (rec.delivery_status || '').toLowerCase();
    const response = (rec.parent_response || '').toLowerCase();
    
    // Confirmed interested parents are excluded from bulk outreach
    if (response === 'interested') return false;
    
    // Unsent, failed, or not interested parents are eligible
    return (
      campaignStatus === 'pending' || 
      campaignStatus === 'failed' || 
      deliveryStatus === 'unsent' || 
      deliveryStatus === 'failed' ||
      response === 'not interested'
    );
  };

  // Template State
  const [templateText, setTemplateText] = useState('');
  const [mediaType, setMediaType] = useState('none'); // 'none', 'image', 'document'
  const [mediaUrl, setMediaUrl] = useState(null);
  const [mediaFilename, setMediaFilename] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaFileMissing, setMediaFileMissing] = useState(false);
  const [templatesList, setTemplatesList] = useState([]);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [templateFilter, setTemplateFilter] = useState('all');
  const [recipientFilter, setRecipientFilter] = useState('all');
  const [saveStatus, setSaveStatus] = useState('synced'); // synced, unsaved, saving
  const [showAddTemplateInput, setShowAddTemplateInput] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [addingTemplate, setAddingTemplate] = useState(false);

  // Uploader State
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [parsedColumns, setParsedColumns] = useState([]);



  // Routing Helpers for Clean URL Navigation
  const getPathFromView = (view, role) => {
    if (role === 'counselor') {
      return view === 'reminders' ? '/counselor/reminders' : '/counselor/dashboard';
    }
    switch (view) {
      case 'outreach': return '/super-admin/dashboard';
      case 'chat': return '/super-admin/inbox';
      case 'bot-builder': return '/super-admin/bot-builder';
      case 'reminders': return '/super-admin/reminders';
      case 'contacts': return '/super-admin/contacts';
      case 'team': return '/super-admin/team';
      default: return '/super-admin/dashboard';
    }
  };

  const getViewFromPath = (path, role) => {
    if (!path || path === '/' || path === '/login') return role === 'counselor' ? 'chat' : 'outreach';
    if (role === 'counselor') {
      return path.includes('reminders') ? 'reminders' : 'chat';
    }
    if (path.includes('inbox') || path.includes('chat')) return 'chat';
    if (path.includes('outreach') || path.includes('dashboard')) return 'outreach';
    if (path.includes('bot-builder')) return 'bot-builder';
    if (path.includes('reminders')) return 'reminders';
    if (path.includes('contacts')) return 'contacts';
    if (path.includes('team')) return 'team';
    return 'outreach';
  };

  // Chat State
  const [activeView, setActiveView] = useState(() => {
    const savedUserStr = localStorage.getItem('currentUserObj');
    let savedRole = 'super_admin';
    if (savedUserStr) {
      try {
        savedRole = JSON.parse(savedUserStr).role || 'super_admin';
      } catch (e) {}
    }
    const path = window.location.pathname;
    return getViewFromPath(path, savedRole);
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [mobileActiveSubView, setMobileActiveSubView] = useState('list');

  const navigateToView = (viewName) => {
    setActiveView(viewName);
    if (currentUser) {
      const targetPath = getPathFromView(viewName, currentUser.role);
      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    }
    if (window.innerWidth <= 1024) {
      setIsSidebarOpen(false);
    }
  };

  useEffect(() => {
    const handleScrollLock = () => {
      if (isSidebarOpen && window.innerWidth <= 1024) {
        document.body.classList.add('sidebar-scroll-lock');
      } else {
        document.body.classList.remove('sidebar-scroll-lock');
      }
    };
    handleScrollLock();
    window.addEventListener('resize', handleScrollLock);
    return () => {
      document.body.classList.remove('sidebar-scroll-lock');
      window.removeEventListener('resize', handleScrollLock);
    };
  }, [isSidebarOpen]);

  // Live Chat State
  const [chatsList, setChatsList] = useState([]);
  const [activeChatRecordId, setActiveChatRecordId] = useState(() => {
    const saved = localStorage.getItem('activeChatRecordId');
    return saved ? parseInt(saved, 10) : null;
  });
  const [chatHistory, setChatHistory] = useState([]);
  const [chatSearchText, setChatSearchText] = useState('');
  const [chatBranchFilter, setChatBranchFilter] = useState('all');
  const [chatStatusFilter, setChatStatusFilter] = useState('all');
  const [typedMessage, setTypedMessage] = useState('');
  const [activeChatSubTab, setActiveChatSubTab] = useState('chat');
  const [chatThreadFilter, setChatThreadFilter] = useState('parent'); // 'parent', 'student'
  const [selectedChatTemplate, setSelectedChatTemplate] = useState('');
  const [forceFreeForm, setForceFreeForm] = useState(false);
  const [sendingChat, setSendingChat] = useState(false);
  const [chatNotes, setChatNotes] = useState([]);
  const [newNoteText, setNewNoteText] = useState('');
  const [notesLoading, setNotesLoading] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [addingNote, setAddingNote] = useState(false);

  const [reminders, setReminders] = useState([]);

  // Contacts State
  const [contactsList, setContactsList] = useState([]);
  const [contactsTotal, setContactsTotal] = useState(0);
  const [contactsPage, setContactsPage] = useState(1);
  const [contactsLimit] = useState(50);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsSearch, setContactsSearch] = useState('');
  const [contactsBranch, setContactsBranch] = useState('all');
  const [contactsTag, setContactsTag] = useState('all');
  const [contactsViewMode, setContactsViewMode] = useState('list'); // 'list' or 'kanban'
  const [campaignRecipient, setCampaignRecipient] = useState('parent'); // 'parent' or 'student'
  const [chatRecipient, setChatRecipient] = useState('parent'); // 'parent' or 'student'
  const [draggedContactId, setDraggedContactId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  
  // Contacts Modals
  const [isAddContactModalOpen, setIsAddContactModalOpen] = useState(false);
  const [isEditContactModalOpen, setIsEditContactModalOpen] = useState(false);
  const [isImportContactsModalOpen, setIsImportContactsModalOpen] = useState(false);
  const [contactToEdit, setContactToEdit] = useState(null);
  
  // Single Contact Form State
  const [newStudentName, setNewStudentName] = useState('');
  const [newParentName, setNewParentName] = useState('');
  const [newPhoneNumber, setNewPhoneNumber] = useState('');
  const [newParentPhoneNumber, setNewParentPhoneNumber] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [newPipelineTag, setNewPipelineTag] = useState('Lead');
  
  // Edit Contact Form State
  const [editStudentName, setEditStudentName] = useState('');
  const [editParentName, setEditParentName] = useState('');
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editParentPhoneNumber, setEditParentPhoneNumber] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editPipelineTag, setEditPipelineTag] = useState('Lead');

  // Contact Ingestion State
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatusText, setImportStatusText] = useState('');

  const [chatSession, setChatSession] = useState({ active: false, time_remaining_seconds: 0 });
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    setSecondsLeft(chatSession.time_remaining_seconds || 0);
  }, [chatSession.time_remaining_seconds]);

  useEffect(() => {
    if (!chatSession.active || secondsLeft <= 0) return;

    const timer = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          setChatSession(curr => ({ ...curr, active: false }));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [chatSession.active, secondsLeft]);

  const formatSecondsToHMS = (totalSeconds) => {
    if (!totalSeconds || totalSeconds <= 0) return "00:00:00";
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  };

  // --- Chat & Auto-Reply API Handlers ---
  
  async function fetchReminders() {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/reminders`);
      if (res.ok) {
        const data = await res.json();
        setReminders(data);
      }
    } catch (err) {
      console.error("Error fetching reminders:", err);
    }
  }

  const playChime = () => {
    try {
      const audio = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-84.wav");
      audio.volume = 0.45;
      audio.play().catch(e => console.log("Audio autoplay prevented by browser. Interaction required first."));
    } catch (err) {
      console.error("Failed to play notification chime:", err);
    }
  };

  async function fetchRecentChats(overrideTab) {
    try {
      const tabToUse = overrideTab || (chatStatusFilter === 'completed' ? 'resolved' : 'active');
      const res = await authFetch(`${API_BASE}/api/v1/chat/recent?chat_tab=${tabToUse}`);
      if (res.ok) {
        const data = await res.json();
        setChatsList(prev => {
          let shouldPlay = false;
          data.forEach(newChat => {
            const oldChat = prev.find(c => c.record.id === newChat.record.id);
            const newMsg = newChat.last_message;
            
            // Play sound if a new message arrives from parent
            if (newMsg && newMsg.sender === 'parent') {
              if (!oldChat || !oldChat.last_message || oldChat.last_message.id !== newMsg.id) {
                shouldPlay = true;
              }
            }
            
            // Play sound if parent response transitions to "Counselor Needed"
            if (newChat.record.parent_response === 'Counselor Needed') {
              if (!oldChat || oldChat.record.parent_response !== 'Counselor Needed') {
                shouldPlay = true;
              }
            }
          });
          
          if (shouldPlay) {
            playChime();
          }
          if (currentUser?.role === 'counselor') {
            if (data.length === 0) {
              setActiveChatRecordId(null);
            } else if (!data.some(c => c.record.id === activeChatRecordId)) {
              setActiveChatRecordId(data[0].record.id);
            }
          } else if (data.length > 0 && !activeChatRecordId) {
            setActiveChatRecordId(data[0].record.id);
          }
          return data;
        });
      }
    } catch (err) {
      console.error("Error fetching recent chats:", err);
    }
  }

  const updateCounselorStatus = async (recordId, newStatus) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${recordId}/counselor-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counselor_status: newStatus })
      });
      if (res.ok) {
        const isCompleted = newStatus === 'completed';
        setChatsList(prev => prev.map(c => c.record.id === recordId ? { 
          ...c, 
          record: { 
            ...c.record, 
            counselor_status: newStatus,
            ...(isCompleted ? { assigned_counselor_id: null, assigned_counselor_name: null } : {})
          } 
        } : c));
        setRecords(prev => prev.map(r => r.id === recordId ? { 
          ...r, 
          counselor_status: newStatus,
          ...(isCompleted ? { assigned_counselor_id: null, assigned_counselor_name: null } : {})
        } : r));
        setContactsList(prev => prev.map(c => c.id === recordId ? { 
          ...c, 
          counselor_status: newStatus,
          ...(isCompleted ? { assigned_counselor_id: null, assigned_counselor_name: null } : {})
        } : c));
        fetchRecentChats();
        fetchWorkloadStats();
        if (isCompleted) {
          triggerToast("✅ Query marked as Completed! Counselor slot unassigned & freed up.", "success");
        } else {
          triggerToast("Status updated to 'Pending (In Progress)'.", "info");
        }
      } else {
        triggerToast("Failed to update counselor status.", "error");
      }
    } catch (err) {
      console.error("Error updating counselor status:", err);
      triggerToast("Failed to update counselor status.", "error");
    }
  };

  const handleUpdateTag = async (recordId, newTag) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${recordId}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_tag: newTag })
      });
      if (res.ok) {
        triggerToast(`Pipeline tag updated to ${newTag}`, "success");
        
        const updatedParentResponse = newTag === 'Not Interested' ? 'Not Interested' 
                                    : newTag === 'Interested' ? 'Interested' 
                                    : null;

        // Update tag in chatsList state
        setChatsList(prev => prev.map(c => {
          if (c.record.id === recordId) {
            const updatedRec = { ...c.record, pipeline_tag: newTag };
            if (updatedParentResponse) {
              updatedRec.parent_response = updatedParentResponse;
            }
            return { ...c, record: updatedRec };
          }
          return c;
        }));
        // Update tag in records grid list state
        setRecords(prev => prev.map(r => {
          if (r.id === recordId) {
            const updatedRec = { ...r, pipeline_tag: newTag };
            if (updatedParentResponse) {
              updatedRec.parent_response = updatedParentResponse;
            }
            return updatedRec;
          }
          return r;
        }));
        // Update tag in contactsList state
        setContactsList(prev => prev.map(c => {
          if (c.id === recordId) {
            const updatedRec = { ...c, pipeline_tag: newTag };
            if (updatedParentResponse) {
              updatedRec.parent_response = updatedParentResponse;
            }
            return updatedRec;
          }
          return c;
        }));
        fetchReminders();
      } else {
        triggerToast("Failed to update pipeline tag.", "error");
      }
    } catch (err) {
      console.error("Error updating tag:", err);
      triggerToast("Failed to update pipeline tag.", "error");
    }
  };

  const handleDragStart = (e, contactId) => {
    setDraggedContactId(contactId);
    e.dataTransfer.setData('text/plain', contactId.toString());
  };

  const handleDragOver = (e, columnTag) => {
    e.preventDefault();
    if (dragOverColumn !== columnTag) {
      setDragOverColumn(columnTag);
    }
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = (e, columnTag) => {
    e.preventDefault();
    setDragOverColumn(null);
    const contactIdStr = e.dataTransfer.getData('text/plain') || draggedContactId;
    if (contactIdStr) {
      const contactId = parseInt(contactIdStr, 10);
      handleUpdateTag(contactId, columnTag);
    }
    setDraggedContactId(null);
  };

  async function fetchChatHistory(recordId) {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/history/${recordId}`);
      if (res.ok) {
        const rawMsgs = data.messages || [];
        const sortedMsgs = [...rawMsgs].sort((a, b) => {
          const tA = new Date(a.created_at).getTime();
          const tB = new Date(b.created_at).getTime();
          if (tA !== tB) return tA - tB;
          return (a.id || 0) - (b.id || 0);
        });
        setChatHistory(sortedMsgs);
        setChatSession(data.session || { active: false, expires_at: null, time_remaining_seconds: 0 });
        // Clear unread count for this record instantly in the local chatsList state
        setChatsList(prev => prev.map(c => 
          c.record.id === recordId ? { ...c, record: { ...c.record, unread_count: 0 } } : c
        ));
      } else {
        setActiveChatRecordId(null);
        setChatHistory([]);
      }
    } catch (err) {
      console.error("Error fetching chat history:", err);
    }
  }

  const fetchChatNotes = async (recordId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${recordId}/notes`);
      if (res.ok) {
        const data = await res.json();
        setChatNotes(data);
      }
    } catch (err) {
      console.error("Error fetching notes:", err);
    }
  };

  const addChatNote = async () => {
    if (!newNoteText.trim() || !activeChatRecordId) return;
    setAddingNote(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${activeChatRecordId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_text: newNoteText })
      });
      if (res.ok) {
        const data = await res.json();
        setChatNotes(prev => [data.note, ...prev]);
        setNewNoteText('');
        // Increment unresolved counts dynamically
        setRecords(prev => prev.map(rec => rec.id === activeChatRecordId ? { ...rec, unresolved_notes_count: (rec.unresolved_notes_count || 0) + 1 } : rec));
        setChatsList(prev => prev.map(c => c.record.id === activeChatRecordId ? { ...c, record: { ...c.record, unresolved_notes_count: (c.record.unresolved_notes_count || 0) + 1 } } : c));
        triggerToast("Note added successfully.", "success");
      } else {
        triggerToast("Failed to add internal note.", "error");
      }
    } catch (err) {
      console.error("Error adding note:", err);
      triggerToast("Failed to add internal note.", "error");
    } finally {
      setAddingNote(false);
    }
  };

  const resolveChatNote = async (noteId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/notes/${noteId}/resolve`, {
        method: 'POST'
      });
      if (res.ok) {
        setChatNotes(prev => prev.map(note => note.id === noteId ? { ...note, resolved: true } : note));
        // Decrement unresolved counts dynamically
        setRecords(prev => prev.map(rec => rec.id === activeChatRecordId ? { ...rec, unresolved_notes_count: Math.max(0, (rec.unresolved_notes_count || 1) - 1) } : rec));
        setChatsList(prev => prev.map(c => c.record.id === activeChatRecordId ? { ...c, record: { ...c.record, unresolved_notes_count: Math.max(0, (c.record.unresolved_notes_count || 1) - 1) } } : c));
        triggerToast("Note marked as resolved.", "success");
      } else {
        triggerToast("Failed to resolve note.", "error");
      }
    } catch (err) {
      console.error("Error resolving note:", err);
      triggerToast("Failed to resolve note.", "error");
    }
  };

  const sendManualMessage = async () => {
    if (!typedMessage.trim() || !activeChatRecordId) return;
    setSendingChat(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: activeChatRecordId,
          message_text: typedMessage,
          recipient_type: chatRecipient
        })
      });
      const data = await res.json();
      if (res.ok) {
        setTypedMessage('');
        forceScrollRef.current = true;
        setChatHistory(prev => [...prev, data.message]);
        fetchRecentChats();
      } else {
        triggerToast(data.detail || "Failed to send message.", "error");
      }
    } catch (err) {
      triggerToast("Error sending message.", "error");
      console.error(err);
    } finally {
      setSendingChat(false);
    }
  };

  const sendManualTemplateMessage = async () => {
    if (!selectedChatTemplate || !activeChatRecordId) return;
    setSendingChat(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/send-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: activeChatRecordId,
          template_name: selectedChatTemplate,
          recipient_type: chatRecipient
        })
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedChatTemplate('');
        forceScrollRef.current = true;
        setChatHistory(prev => [...prev, data.message]);
        setForceFreeForm(false);
        fetchRecentChats();
        fetchChatHistory(activeChatRecordId);
        triggerToast("Template sent successfully!", "success");
      } else {
        triggerToast(data.detail || "Failed to send template.", "error");
      }
    } catch (err) {
      triggerToast("Error sending template.", "error");
      console.error(err);
    } finally {
      setSendingChat(false);
    }
  };

  async function fetchAutoReplyRules() {
    // Auto-reply rules removed in favor of Flow Builder
  }

  const saveAutoReplyRule = async () => {
    if (!newRuleKeyword.trim() || !newRuleReply.trim()) {
      triggerToast("Keyword and reply text cannot be empty.", "error");
      return;
    }
    setSavingRule(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: newRuleKeyword,
          reply_text: newRuleReply
        })
      });
      if (res.ok) {
        setNewRuleKeyword('');
        setNewRuleReply('');
        triggerToast("Auto-reply rule saved.", "success");
        fetchAutoReplyRules();
      } else {
        const data = await res.json();
        triggerToast(data.detail || "Failed to save rule.", "error");
      }
    } catch (err) {
      triggerToast("Error saving rule.", "error");
      console.error(err);
    } finally {
      setSavingRule(false);
    }
  };

  const deleteAutoReplyRule = async (ruleId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/rules/${ruleId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        triggerToast("Auto-reply rule deleted.", "success");
        fetchAutoReplyRules();
      } else {
        triggerToast("Failed to delete rule.", "error");
      }
    } catch (err) {
      triggerToast("Error deleting rule.", "error");
      console.error(err);
    }
  };

  const handleAssignLead = async (contactId, counselorId, counselorName) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/contacts/${contactId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counselor_id: counselorId, counselor_name: counselorName })
      });
      if (res.ok) {
        const newStatus = counselorId ? 'pending' : null;
        setChatsList(prev => prev.map(c => c.record.id === contactId ? {
          ...c,
          record: {
            ...c.record,
            assigned_counselor_id: counselorId,
            assigned_counselor_name: counselorName,
            counselor_status: newStatus
          }
        } : c));
        setRecords(prev => prev.map(r => r.id === contactId ? {
          ...r,
          assigned_counselor_id: counselorId,
          assigned_counselor_name: counselorName,
          counselor_status: newStatus
        } : r));
        setContactsList(prev => prev.map(c => c.id === contactId ? {
          ...c,
          assigned_counselor_id: counselorId,
          assigned_counselor_name: counselorName,
          counselor_status: newStatus
        } : c));

        if (counselorId) {
          triggerToast(`Lead assigned to ${counselorName || 'Counselor'} (Status: Pending)`, 'success');
        } else {
          triggerToast('Lead set to Unassigned', 'info');
        }
        fetchRecentChats();
        fetchContacts(contactsPage);
        fetchWorkloadStats();
      } else {
        triggerToast("Failed to assign lead.", "error");
      }
    } catch (err) {
      console.error("Error assigning lead:", err);
      triggerToast("Error assigning lead.", "error");
    }
  };

  const handleAutoAssignLead = async (contactId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/contacts/${contactId}/auto-assign`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok) {
        const assignedUser = data.assigned_to;
        const assignedName = assignedUser?.full_name || assignedUser?.username || 'Counselor';
        const assignedId = assignedUser?.id || null;

        setChatsList(prev => prev.map(c => c.record.id === contactId ? {
          ...c,
          record: {
            ...c.record,
            assigned_counselor_id: assignedId,
            assigned_counselor_name: assignedName,
            counselor_status: 'pending'
          }
        } : c));
        setRecords(prev => prev.map(r => r.id === contactId ? {
          ...r,
          assigned_counselor_id: assignedId,
          assigned_counselor_name: assignedName,
          counselor_status: 'pending'
        } : r));
        setContactsList(prev => prev.map(c => c.id === contactId ? {
          ...c,
          assigned_counselor_id: assignedId,
          assigned_counselor_name: assignedName,
          counselor_status: 'pending'
        } : c));

        triggerToast(`⚡ Lead auto-assigned to ${assignedName} (Status: Pending)`, 'success');
        fetchRecentChats();
        fetchContacts(contactsPage);
        fetchWorkloadStats();
      } else {
        triggerToast(data.detail || "Failed to auto-assign lead.", "error");
      }
    } catch (err) {
      console.error("Error auto-assigning lead:", err);
      triggerToast("Error auto-assigning lead.", "error");
    }
  };

  // Fetch chats, team users, and workload stats when switching to Chat View
  useEffect(() => {
    if (!token || activeView !== 'chat') return;
    
    fetchRecentChats();
    fetchTeamUsers();
    fetchWorkloadStats();
    fetchAutoReplyRules();
    
    const chatsInterval = setInterval(() => {
      fetchRecentChats();
      fetchWorkloadStats();
    }, 8000);
    
    return () => clearInterval(chatsInterval);
  }, [token, activeView]);

  // Global poll for recent chats & initial data fetch
  useEffect(() => {
    if (!token) return;
    
    // Initial fetch
    fetchRecentChats();
    fetchCurrentUser();
    fetchTeamUsers();
    fetchWorkloadStats();
    
    const globalChatsInterval = setInterval(() => {
      if (activeView !== 'chat') {
        fetchRecentChats();
      }
    }, 10000);
    
    return () => clearInterval(globalChatsInterval);
  }, [token, activeView]);

  // Enforce Role-Based Access Control (RBAC) View Guard & Team Fetching
  useEffect(() => {
    if (!currentUser) return;
    
    if (currentUser.role === 'super_admin') {
      if (activeView === 'team') {
        fetchTeamUsers();
      }
    } else if (currentUser.role === 'counselor') {
      // Counselors are strictly restricted to chat (My Assigned Chats) and reminders (My Scheduled Reminders)
      if (['team', 'outreach', 'bot-builder', 'brochures', 'contacts'].includes(activeView)) {
        if (activeView === 'team') {
          triggerToast("Access Denied: Team & Staff Management requires Super Admin privileges.", "error");
        }
        setActiveView('chat');
      }
    }
  }, [currentUser, activeView]);

  // Sync URL pathname with activeView and login state
  useEffect(() => {
    if (!token) {
      if (window.location.pathname !== '/login') {
        window.history.replaceState(null, '', '/login');
      }
      return;
    }
    if (currentUser) {
      const targetPath = getPathFromView(activeView, currentUser.role);
      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    }
  }, [token, currentUser, activeView]);

  // Handle browser back/forward buttons (popstate)
  useEffect(() => {
    const handlePopState = () => {
      if (!token) {
        if (window.location.pathname !== '/login') {
          window.history.replaceState(null, '', '/login');
        }
        return;
      }
      if (currentUser) {
        const view = getViewFromPath(window.location.pathname, currentUser.role);
        if (view) setActiveView(view);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [token, currentUser]);

  // Set up polling for active chat history if one is selected
  useEffect(() => {
    if (!token || activeView !== 'chat' || !activeChatRecordId) return;
    
    fetchChatHistory(activeChatRecordId);
    
    const historyInterval = setInterval(() => {
      fetchChatHistory(activeChatRecordId);
    }, 4000);
    
    return () => clearInterval(historyInterval);
  }, [token, activeView, activeChatRecordId]);

  // Notifications State
  const [toasts, setToasts] = useState([]);

  // Refs for upload and search debounce
  const fileInputRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const logsEndRef = useRef(null);
  const chatBottomRef = useRef(null);
  const chatContainerRef = useRef(null);
  const prevActiveChatRecordIdRef = useRef(null);
  const forceScrollRef = useRef(false);

  // ----------------------------------------------------
  // LIFECYCLE & POLLING
  // ----------------------------------------------------
  // Keep latest filter, search, page state in a ref to avoid stale closures in the polling interval
  const pollingStateRef = useRef({ currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter });
  useEffect(() => {
    pollingStateRef.current = { currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter };
  }, [currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter]);

  const forceChatScrollRef = useRef(false);
  const isChatSelectionChangedRef = useRef(true);

  // Mark chat selection as changed whenever activeChatRecordId, chatThreadFilter, or activeChatSubTab changes
  useEffect(() => {
    isChatSelectionChangedRef.current = true;
  }, [activeChatRecordId, chatThreadFilter, activeChatSubTab]);

  // Dynamically default recipient type and thread filter based on phone number registration
  useEffect(() => {
    if (!activeChatRecordId) {
      prevActiveChatRecordIdRef.current = null;
      return;
    }
    if (prevActiveChatRecordIdRef.current !== activeChatRecordId) {
      const activeRec = chatsList.find(c => c.record.id === activeChatRecordId)?.record 
                      || contactsList.find(c => c.id === activeChatRecordId);
      if (activeRec) {
        prevActiveChatRecordIdRef.current = activeChatRecordId;
        if (!activeRec.parent_phone_number || activeRec.parent_phone_number.trim() === '') {
          setChatThreadFilter('student');
          setChatRecipient('student');
        } else {
          setChatThreadFilter('parent');
          setChatRecipient('parent');
        }
      }
    }
  }, [activeChatRecordId, chatsList, contactsList]);

  // Auto-scroll to the bottom of chat messages
  useEffect(() => {
    if (!activeChatRecordId || activeChatSubTab !== 'chat') return;

    const scrollToBottom = () => {
      const container = chatContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
        if (chatBottomRef.current) {
          chatBottomRef.current.scrollIntoView({ behavior: 'instant', block: 'end' });
        }
      }
    };

    const isSelectionChanged = isChatSelectionChangedRef.current;
    const isForced = forceScrollRef.current;
    const container = chatContainerRef.current;
    const threshold = 250;
    const isNearBottom = container ? (container.scrollHeight - container.scrollTop - container.clientHeight) <= threshold : true;

    if (isSelectionChanged || isNearBottom || isForced) {
      scrollToBottom();
      
      // Retry multiple times to ensure scroll succeeds even if images or layout calculations take time
      const t1 = setTimeout(scrollToBottom, 50);
      const t2 = setTimeout(scrollToBottom, 150);
      const t3 = setTimeout(scrollToBottom, 350);
      const t4 = setTimeout(scrollToBottom, 600);

      if (isSelectionChanged) {
        isChatSelectionChangedRef.current = false;
      }
      forceScrollRef.current = false;

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        clearTimeout(t4);
      };
    }
  }, [chatHistory, activeChatRecordId, chatThreadFilter, activeChatSubTab]);

  // Sync activeView to localStorage
  useEffect(() => {
    localStorage.setItem('activeView', activeView);
  }, [activeView]);

  // Sync activeChatRecordId to localStorage
  useEffect(() => {
    if (activeChatRecordId !== null) {
      localStorage.setItem('activeChatRecordId', activeChatRecordId);
    } else {
      localStorage.removeItem('activeChatRecordId');
    }
  }, [activeChatRecordId]);

  useEffect(() => {
    if (!token) return;
    
    // Initial fetch
    fetchStats(selectedTemplateName);
    fetchTemplatesList(true);
    fetchBranches();
    fetchReminders();
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);

    // Poll statistics and grid periodically to pick up async background sends
    const interval = setInterval(() => {
      fetchStats(pollingStateRef.current.selectedTemplateName);
      fetchBranches();
      fetchReminders();
      fetchRecords(
        pollingStateRef.current.currentPage, 
        pollingStateRef.current.dispatchFilter, 
        pollingStateRef.current.deliveryFilter, 
        pollingStateRef.current.readFilter, 
        pollingStateRef.current.responseFilter, 
        pollingStateRef.current.search, 
        pollingStateRef.current.branchFilter, 
        pollingStateRef.current.templateFilter,
        pollingStateRef.current.pipelineTagFilter,
        pollingStateRef.current.pendingNotesFilter,
        false
      ); // silent refresh without full loader
    }, 6000);

    return () => clearInterval(interval);
  }, [token]);

  // Handle stats reload when selected template changes
  useEffect(() => {
    if (!token) return;
    fetchStats(selectedTemplateName);
  }, [selectedTemplateName, token]);

  // Cascading dependency handlers
  const handleDispatchFilterChange = (val) => {
    setDispatchFilter(val);
    if (val !== 'sent') {
      setDeliveryFilter('all');
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleDeliveryFilterChange = (val) => {
    setDeliveryFilter(val);
    if (val !== 'delivered') {
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleReadFilterChange = (val) => {
    setReadFilter(val);
    if (val !== 'read') {
      setResponseFilter('all');
    }
  };

  // Handle filter changes
  useEffect(() => {
    if (!token) return;
    setCurrentPage(1);
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, templateFilter, recipientFilter, pipelineTagFilter, pendingNotesFilter, token]);

  // Handle search changes with 300ms debounce
  useEffect(() => {
    if (!token) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    
    searchTimeoutRef.current = setTimeout(() => {
      setCurrentPage(1);
      fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
    }, 300);

    return () => clearTimeout(searchTimeoutRef.current);
  }, [search, token]);

  // Reset selected checkboxes on filter/search or page change
  useEffect(() => {
    setSelectedRecordIds([]);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, templateFilter, recipientFilter, pipelineTagFilter, pendingNotesFilter, search, currentPage]);

  // Fetch contacts when filters, activeView, or contactsViewMode changes
  useEffect(() => {
    if (!token) return;
    if (activeView === 'contacts') {
      fetchContacts(contactsPage);
    }
  }, [activeView, contactsPage, contactsBranch, contactsTag, contactsViewMode, token]);

  // Debounced search for contacts
  useEffect(() => {
    if (!token || activeView !== 'contacts') return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    
    searchTimeoutRef.current = setTimeout(() => {
      setContactsPage(1);
      fetchContacts(1);
    }, 300);

    return () => clearTimeout(searchTimeoutRef.current);
  }, [contactsSearch, token]);

  // Sync contactsBranch and branchFilter states if selected branch is deleted/no longer exists
  useEffect(() => {
    if (contactsBranch !== 'all' && !branches.includes(contactsBranch)) {
      setContactsBranch('all');
      setContactsPage(1);
    }
  }, [branches, contactsBranch]);

  useEffect(() => {
    if (branchFilter !== 'all' && !branches.includes(branchFilter)) {
      setBranchFilter('all');
      setCurrentPage(1);
    }
  }, [branches, branchFilter]);


  // Scroll sandbox logs to bottom


  // Trigger Excel download of filtered results
  const handleExportExcel = async () => {
    const params = new URLSearchParams();
    
    // Formulate parameters identical to fetchRecords
    if (dispatchFilter === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchFilter === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchFilter === 'sent') {
      params.append('campaign_status', 'Sent');
      
      if (deliveryFilter === 'undelivered') {
        params.append('delivery_status', 'undelivered');
      } else if (deliveryFilter === 'delivered') {
        if (readFilter === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readFilter === 'read') {
          if (responseFilter === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }
    
    if (search.trim()) {
      params.append('search', search.trim());
    }
    
    if (branchFilter && branchFilter !== 'all') {
      params.append('branch', branchFilter);
    }

    if (templateFilter && templateFilter !== 'all') {
      params.append('template', templateFilter);
    }

    if (recipientFilter && recipientFilter !== 'all') {
      params.append('recipient_type', recipientFilter);
    }
    
    if (pipelineTagFilter && pipelineTagFilter !== 'all') {
      params.append('pipeline_tag', pipelineTagFilter);
    }
    
    try {
      triggerToast("Generating Excel export...", "info");
      const res = await authFetch(`${API_BASE}/api/v1/records/export?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to generate export file from server.");
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `filtered_contacts_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      triggerToast("Excel export downloaded successfully.", "success");
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Failed to export Excel.", "error");
    }
  };

  // ----------------------------------------------------

  // TOAST ALERTS SYSTEM
  // ----------------------------------------------------
  function triggerToast(message, type = 'info') {
    const id = Date.now() + Math.random().toString(36).substr(2, 5);
    setToasts(prev => [...prev, { id, message, type }]);
    
    // Auto dismiss after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };



  // ----------------------------------------------------
  // CONTACTS OPERATIONS
  // ----------------------------------------------------
  async function fetchContacts(page = 1, customLimit = null) {
    if (!token) return;
    setContactsLoading(true);
    try {
      const activeLimit = customLimit || (contactsViewMode === 'kanban' ? 1000 : contactsLimit);
      let url = `${API_BASE}/api/v1/contacts?page=${page}&limit=${activeLimit}`;
      if (contactsSearch) {
        url += `&search=${encodeURIComponent(contactsSearch)}`;
      }
      if (contactsBranch && contactsBranch !== 'all') {
        url += `&branch=${encodeURIComponent(contactsBranch)}`;
      }
      if (contactsTag && contactsTag !== 'all') {
        url += `&pipeline_tag=${encodeURIComponent(contactsTag)}`;
      }
      
      const res = await authFetch(url);
      const data = await res.json();
      if (res.ok) {
        setContactsList(data.contacts || []);
        setContactsTotal(data.total || 0);
        setContactsPage(data.page || 1);
      } else {
        throw new Error(data.detail || "Failed to load contacts.");
      }
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setContactsLoading(false);
    }
  }

  const handleAddContact = async (e) => {
    e.preventDefault();
    if (!newStudentName || !newParentName || !newPhoneNumber || !newBranch) {
      triggerToast("Please fill all required fields.", "error");
      return;
    }
    try {
      const res = await authFetch(`${API_BASE}/api/v1/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_name: newStudentName,
          parent_name: newParentName,
          phone_number: newPhoneNumber,
          parent_phone_number: newParentPhoneNumber,
          selected_branch: newBranch,
          pipeline_tag: newPipelineTag
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to create contact.");
      
      triggerToast("Contact created successfully!", "success");
      setIsAddContactModalOpen(false);
      
      // Reset form fields
      setNewStudentName('');
      setNewParentName('');
      setNewPhoneNumber('');
      setNewParentPhoneNumber('');
      setNewBranch('');
      setNewPipelineTag('Lead');
      
      fetchContacts(1);
      fetchBranches();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  const handleEditContact = async (e) => {
    e.preventDefault();
    if (!editStudentName || !editParentName || !editPhoneNumber || !editBranch) {
      triggerToast("Please fill all required fields.", "error");
      return;
    }
    try {
      const res = await authFetch(`${API_BASE}/api/v1/contacts/${contactToEdit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_name: editStudentName,
          parent_name: editParentName,
          phone_number: editPhoneNumber,
          parent_phone_number: editParentPhoneNumber,
          selected_branch: editBranch,
          pipeline_tag: editPipelineTag
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to update contact.");
      
      triggerToast("Contact updated successfully!", "success");
      setIsEditContactModalOpen(false);
      setContactToEdit(null);
      fetchContacts(contactsPage);
      fetchBranches();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  const handleDeleteContact = async (id) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Contact",
      message: "Are you sure you want to delete this contact? This will delete all chat histories, messages, and campaign logs associated with this phone number permanently.",
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await authFetch(`${API_BASE}/api/v1/contacts/${id}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to delete contact.");
          
          triggerToast("Contact deleted successfully.", "success");
          
          // Clear active chat state if the deleted contact was selected
          if (activeChatRecordId === id) {
            setActiveChatRecordId(null);
            setChatHistory([]);
            setChatNotes([]);
          }
          
          fetchContacts(contactsPage);
          fetchBranches();
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  const handleImportContacts = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    
    setImporting(true);
    setImportProgress(0);
    setImportStatusText(`Uploading & parsing contacts: ${file.name}...`);
    
    let width = 0;
    const interval = setInterval(() => {
      if (width < 90) {
        width += 15;
        setImportProgress(width);
      }
    }, 80);
    
    try {
      const res = await authFetch(`${API_BASE}/api/v1/contacts/upload`, {
        method: 'POST',
        body: formData
      });
      clearInterval(interval);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Spreadsheet ingestion failed.");
      
      setImportProgress(100);
      setImportStatusText(`Success: ${data.message}`);
      triggerToast(data.message, "success");
      
      setTimeout(() => {
        setImporting(false);
        setIsImportContactsModalOpen(false);
        fetchContacts(1);
        fetchBranches();
      }, 1500);
    } catch (err) {
      clearInterval(interval);
      setImportProgress(0);
      setImportStatusText(`Failed: ${err.message}`);
      triggerToast(err.message, "error");
      setTimeout(() => setImporting(false), 3000);
    }
  };

  // ----------------------------------------------------
  // API CALLS
  // ----------------------------------------------------

  // Fetch Dashboard aggregate statistics
  async function fetchStats(tmpl = null) {
    try {
      const url = tmpl ? `${API_BASE}/api/v1/stats?template=${encodeURIComponent(tmpl)}` : `${API_BASE}/api/v1/stats`;
      const res = await authFetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to load statistics counters.");
    }
  }



  // Fetch unique academic branches present in database
  async function fetchBranches() {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/branches`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setBranches(data);
    } catch (err) {
      console.error("Failed to load academic branches.");
    }
  }

  // Fetch paginated grid records
  async function fetchRecords(page, dispatchF, deliveryF, readF, responseF, searchTerm, branchF, templateF, tagF = 'all', pendingNotesF = false, showLoader = true) {
    // If showLoader is passed as false in the 10th or 11th position, we adjust.
    // To handle calls where pendingNotesF is omitted but showLoader is passed as the 10th parameter:
    let actualPendingNotes = pendingNotesF;
    let actualShowLoader = showLoader;
    if (typeof pendingNotesF === 'boolean' && showLoader === undefined) {
      // If only 10 arguments are passed and the 10th is a boolean, it might be showLoader.
      // But we always pass 11 arguments from our calls, so this is just for safety.
      actualShowLoader = pendingNotesF;
      actualPendingNotes = false;
    }
    
    if (actualShowLoader) setGridLoading(true);
    
    const params = new URLSearchParams();
    params.append('page', page);
    params.append('limit', RECORDS_PER_PAGE);
    
    if (searchTerm.trim()) params.append('search', searchTerm.trim());
    
    if (branchF && branchF !== 'all') {
      params.append('branch', branchF);
    }
    if (templateF && templateF !== 'all') {
      params.append('template', templateF);
    }
    if (recipientFilter && recipientFilter !== 'all') {
      params.append('recipient_type', recipientFilter);
    }
    // 1. Process Dispatch/Delivery/Read/Response cascading filters
    if (dispatchF === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchF === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchF === 'sent') {
      params.append('campaign_status', 'Sent');
      
      if (deliveryF === 'pending') {
        params.append('delivery_status', 'pending');
      } else if (deliveryF === 'delivered') {
        if (readF === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readF === 'read') {
          if (responseF === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseF === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseF === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }

    // 2. Process other filters
    if (tagF && tagF !== 'all') {
      params.append('pipeline_tag', tagF);
    }
    if (actualPendingNotes) {
      params.append('has_unresolved_notes', 'true');
    }

    try {
      const res = await authFetch(`${API_BASE}/api/v1/records?${params.toString()}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      
      setRecords(data.records);
      setTotalCount(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.pages);
      setGridError('');
    } catch (err) {
      console.error(err);
      setGridError("Failed to retrieve admission details from the database.");
    } finally {
      if (showLoader) setGridLoading(false);
    }
  };

  // Fetch templates list
  async function fetchTemplatesList(selectActive = false) {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTemplatesList(data);
      
      if (selectActive) {
        const active = data.find(t => t.is_active);
        if (active) {
          setSelectedTemplateName(active.template_name);
          setTemplateFilter(active.template_name);
          setTemplateText(active.template_text);
          setMediaType(active.media_type || 'none');
          setMediaUrl(active.media_url || null);
          setMediaFileMissing(active.media_file_missing || false);
          if (active.media_url) {
            const parts = active.media_url.split('/');
            setMediaFilename(parts[parts.length - 1]);
          } else {
            setMediaFilename('');
          }
        } else if (data.length > 0) {
          setSelectedTemplateName(data[0].template_name);
          setTemplateFilter(data[0].template_name);
          setTemplateText(data[0].template_text);
          setMediaType(data[0].media_type || 'none');
          setMediaUrl(data[0].media_url || null);
          setMediaFileMissing(data[0].media_file_missing || false);
          if (data[0].media_url) {
            const parts = data[0].media_url.split('/');
            setMediaFilename(parts[parts.length - 1]);
          } else {
            setMediaFilename('');
          }
        }
      }
    } catch (err) {
      console.error("Error loading templates list:", err);
    }
  }

  const handleTemplateChange = async (name) => {
    setSelectedTemplateName(name);
    setTemplateFilter(name);
    const tmpl = templatesList.find(t => t.template_name === name);
    if (tmpl) {
      setTemplateText(tmpl.template_text);
      setMediaType(tmpl.media_type || 'none');
      setMediaUrl(tmpl.media_url || null);
      setMediaFileMissing(tmpl.media_file_missing || false);
      if (tmpl.media_url) {
        const parts = tmpl.media_url.split('/');
        setMediaFilename(parts[parts.length - 1]);
      } else {
        setMediaFilename('');
      }
      setSaveStatus('synced');
      
      try {
        await authFetch(`${API_BASE}/api/v1/templates/active`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_name: name })
        });
        setTemplatesList(prev => prev.map(t => ({
          ...t,
          is_active: t.template_name === name
        })));
        triggerToast(`Active template switched to ${name}`, "success");
        fetchStats(name);
      } catch (err) {
        console.error("Error updating active template:", err);
        triggerToast("Failed to update active template selection.", "error");
      }
    }
  };

  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const handleSyncTemplates = async () => {
    setSyncingTemplates(true);
    triggerToast("Syncing approved templates from Meta...", "info");
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates/sync`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to sync templates.");
      
      triggerToast(data.message || "Templates synced successfully.", "success");
      await fetchTemplatesList(true);
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Error syncing templates.", "error");
    } finally {
      setSyncingTemplates(false);
    }
  };

  const handleAddTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      triggerToast("Please enter a template name.", "error");
      return;
    }
    
    setAddingTemplate(true);
    triggerToast(`Fetching template '${name}' from Meta...`, "info");
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_name: name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to add template.");
      
      triggerToast(data.message || `Template '${name}' added successfully.`, "success");
      setNewTemplateName('');
      setShowAddTemplateInput(false);
      
      // Refresh templates list and select this newly added one
      await fetchTemplatesList(false);
      const t = data.template;
      setSelectedTemplateName(t.template_name);
      setTemplateFilter(t.template_name);
      setTemplateText(t.template_text);
      setMediaType(t.media_type || 'none');
      setMediaUrl(t.media_url || null);
      setMediaFileMissing(t.media_file_missing || false);
      if (t.media_url) {
        const parts = t.media_url.split('/');
        setMediaFilename(parts[parts.length - 1]);
      } else {
        setMediaFilename('');
      }
      setSaveStatus('synced');
      fetchStats(t.template_name);
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Error adding template.", "error");
    } finally {
      setAddingTemplate(false);
    }
  };

  // Save template text
  const handleSaveTemplate = async () => {
    if (!templateText.trim()) {
      triggerToast("Template text cannot be empty.", "error");
      return;
    }
    setSaveStatus('saving');
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          template_name: selectedTemplateName,
          template_text: templateText,
          media_type: mediaType,
          media_url: mediaUrl
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to save template.");
      
      // Update local templates list
      setTemplatesList(prev => prev.map(t => t.template_name === selectedTemplateName ? {
        ...t,
        template_text: data.template_text,
        media_type: data.media_type,
        media_url: data.media_url,
        media_file_missing: false
      } : t));
      
      setSaveStatus('synced');
      triggerToast("Template saved successfully.", "success");
    } catch (err) {
      setSaveStatus('unsaved');
      triggerToast(err.message, "error");
    }
  };

  // Upload template media file
  const handleMediaUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setMediaUploading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template/upload-media`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Media upload failed.");

      setMediaUrl(data.media_url);
      setMediaFilename(file.name);
      setMediaFileMissing(false);
      setSaveStatus('unsaved');
      triggerToast("Media file uploaded successfully.", "success");
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setMediaUploading(false);
      e.target.value = '';
    }
  };

  // Upload spreadsheet
  const handleFileUpload = async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      triggerToast("Invalid format. Please upload an Excel (.xlsx) or CSV (.csv) file.", "error");
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setUploading(true);
    setUploadProgress(0);
    setUploadStatusText(`Uploading file: ${file.name}...`);

    // Animate progress bar loader
    let width = 0;
    const progressInterval = setInterval(() => {
      if (width < 90) {
        width += 15;
        setUploadProgress(width);
      }
    }, 80);

    try {
      const res = await authFetch(`${API_BASE}/api/v1/upload`, {
        method: 'POST',
        body: formData
      });
      clearInterval(progressInterval);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload ingestion failed.");

      setUploadProgress(100);
      setUploadStatusText(`Success: ${data.message}`);
      triggerToast(data.message, "success");
      setParsedColumns(data.columns || []);

      setTimeout(() => {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        refreshDashboard();
      }, 1500);

    } catch (err) {
      clearInterval(progressInterval);
      setUploadProgress(0);
      setUploadStatusText(`Ingestion Failed: ${err.message}`);
      triggerToast(err.message, "error");
      setTimeout(() => setUploading(false), 3000);
    }
  };

  // Launch broadcast campaign
  const handleLaunchBroadcast = async () => {
    setConfirmModal({
      isOpen: true,
      title: 'Launch Broadcast Campaign',
      message: `Are you sure you want to launch the broadcast campaign? This will send outreach messages to all pending candidates (${campaignRecipient} numbers) in the database.`,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await authFetch(`${API_BASE}/api/v1/campaign/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_type: campaignRecipient })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Broadcast trigger failed.");

          if (data.status === 'ignored') {
            triggerToast(data.message, "info");
          } else {
            triggerToast(data.message, "success");
          }
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  // Dispatch campaign to single contact
  const handleSendSingle = async (id) => {
    triggerToast("Dispatching single campaign request...", "info");
    try {
      const templateToSend = templateFilter === 'all' ? selectedTemplateName : templateFilter;
      const url = `${API_BASE}/api/v1/campaign/send-single/${id}?recipient_type=${campaignRecipient}${templateToSend ? `&template_name=${encodeURIComponent(templateToSend)}` : ''}`;
      const res = await authFetch(url, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Single sending failed.");
      
      triggerToast(data.message, "success");
      refreshDashboard();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  // Trigger bulk campaign messages
  const handleBulkSend = async () => {
    if (selectedRecordIds.length === 0) return;
    
    const eligibleRecords = records.filter(r => selectedRecordIds.includes(r.id) && r.parent_response !== 'Interested');
    const interestedCount = selectedRecordIds.length - eligibleRecords.length;
    
    if (eligibleRecords.length === 0) {
      triggerToast("No eligible candidates selected. Outreach is disabled for confirmed Interested parents.", "error");
      return;
    }
    
    let confirmMsg = `Are you sure you want to send outreach messages to ${eligibleRecords.length} selected candidate(s) (${campaignRecipient} numbers)?`;
    if (interestedCount > 0) {
      confirmMsg += ` (${interestedCount} confirmed Interested parent(s) will be automatically skipped to prevent spam.)`;
    }
    
    setConfirmModal({
      isOpen: true,
      title: 'Confirm Outreach Dispatch',
      message: confirmMsg,
      onConfirm: async () => {
        closeConfirmModal();
        triggerToast("Initiating bulk campaign dispatch...", "info");
        try {
          const templateToSend = templateFilter === 'all' ? selectedTemplateName : templateFilter;
          const res = await authFetch(`${API_BASE}/api/v1/campaign/send-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              record_ids: eligibleRecords.map(r => r.id),
              template_name: templateToSend,
              recipient_type: campaignRecipient
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to trigger bulk dispatch.");
          
          triggerToast(data.message, "success");
          setSelectedRecordIds([]);
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };



  // Reset uploader display
  const handleResetUploader = () => {
    setParsedColumns([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Helper refresh
  const refreshDashboard = () => {
    fetchStats();
    fetchRecords(
      pollingStateRef.current.currentPage, 
      pollingStateRef.current.dispatchFilter, 
      pollingStateRef.current.deliveryFilter, 
      pollingStateRef.current.readFilter, 
      pollingStateRef.current.responseFilter, 
      pollingStateRef.current.search, 
      pollingStateRef.current.branchFilter,
      pollingStateRef.current.templateFilter,
      pollingStateRef.current.pipelineTagFilter,
      pollingStateRef.current.pendingNotesFilter,
      false
    );
  };

  // ----------------------------------------------------
  // INTERACTIVE TEMPLATE PREVIEW HELPERS
  // ----------------------------------------------------
  const getTemplateFields = () => {
    const tmpl = templatesList.find(t => t.template_name === selectedTemplateName);
    if (!tmpl) return { required: [], missing: [] };
    
    const vars = tmpl.variable_names 
      ? tmpl.variable_names.split(',').map(v => v.trim()).filter(Boolean) 
      : [];
      
    if (vars.length === 0) {
      return { required: [], missing: [] };
    }
    
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const missing = [];
    if (parsedColumns.length > 0) {
      const normalizedColumns = parsedColumns.map(c => normalize(c));
      
      vars.forEach(v => {
        const normV = normalize(v);
        
        // Define synonym groups for standard mapping
        const studentSynonyms = ['studentname', 'student', 'candidatename', 'candidate'];
        const parentSynonyms = ['parentname', 'parent', 'fathername', 'mothername', 'guardianname', 'guardian'];
        const branchSynonyms = ['selectedbranch', 'branch', 'course', 'selectedcourse', 'status', 'admissionstatus', 'dept', 'department'];
        
        let found = normalizedColumns.includes(normV);
        
        if (!found) {
          if (studentSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => studentSynonyms.includes(c));
          } else if (parentSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => parentSynonyms.includes(c));
          } else if (branchSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => branchSynonyms.includes(c));
          }
        }
        
        if (!found) {
          missing.push(v);
        }
      });
    }
    
    return { required: vars, missing };
  };

  const { required: requiredFields, missing: missingFields } = getTemplateFields();

  const renderLivePreviewText = () => {
    if (!templateText) {
      return <span className="text-muted">Type template text above...</span>;
    }
    
    let preview = escapeHTML(templateText);
    preview = preview.replace(/\[Parent Name\]/g, '<span class="var">Rohan Kumar</span>');
    preview = preview.replace(/\[Student Name\]/g, '<span class="var">Rajesh Kumar</span>');
    preview = preview.replace(/\[Selected Branch\]/g, '<span class="var">Computer Science</span>');
    preview = preview.replace(/\[Phone Number\]/g, '<span class="var">919876543210</span>');
    
    return <span dangerouslySetInnerHTML={{ __html: preview }} />;
  };

  const insertToken = (token) => {
    const editor = document.getElementById('template-editor-textarea');
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = templateText;

    const newText = text.substring(0, start) + token + text.substring(end);
    setTemplateText(newText);
    setSaveStatus('unsaved');

    // Return focus to editor
    setTimeout(() => {
      editor.focus();
      editor.selectionStart = editor.selectionEnd = start + token.length;
    }, 0);
  };

  // ----------------------------------------------------
  // COMPONENT EVENT HANDLERS
  // ----------------------------------------------------
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };



  // Helper helper
  const changePage = (dir) => {
    const target = currentPage + dir;
    if (target >= 1 && target <= totalPages) {
      setCurrentPage(target);
      fetchRecords(target, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
    }
  };

  const formatSessionTime = (seconds) => {
    if (!seconds || seconds <= 0) return "expired";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) {
      return `${hrs}hr ${mins}m left`;
    }
    return `${mins}m left`;
  };

  // ----------------------------------------------------
  // HTML ESCAPE AND UTILITIES
  // ----------------------------------------------------
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Calc read percentage rates
  const readRate = stats.sent > 0 ? Math.round((stats.read / stats.sent) * 100) : 0;

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    e.currentTarget.style.setProperty('--mouse-x', `${x}px`);
    e.currentTarget.style.setProperty('--mouse-y', `${y}px`);
  };

  if (!token) {
    return (
      <div className="login-screen-container" onMouseMove={handleMouseMove}>
        {/* Animated background shape layers */}
        <div className="login-bg-shape login-bg-shape-1"></div>
        <div className="login-bg-shape login-bg-shape-2"></div>
        
        <div className="login-card">
          <div className="login-card-header">
            <div className="login-logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h2>Admin Portal</h2>
            <p>Sign in to access the admission engine</p>
          </div>

          {loginError && (
            <div className="login-error-alert">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin}>
            <div className="login-form-group">
              <label htmlFor="username">Username</label>
              <div className="login-input-container">
                <input
                  id="username"
                  type="text"
                  className="login-input"
                  placeholder="Enter username"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  disabled={loginLoading}
                  required
                />
                <div className="login-input-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                </div>
              </div>
            </div>

            <div className="login-form-group">
              <label htmlFor="password">Password</label>
              <div className="login-input-container">
                <input
                  id="password"
                  type="password"
                  className="login-input"
                  placeholder="Enter password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  disabled={loginLoading}
                  required
                />
                <div className="login-input-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                </div>
              </div>
            </div>

            <button type="submit" className="login-button" disabled={loginLoading}>
              {loginLoading ? (
                <>Signing in...</>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                    <polyline points="10 17 15 12 10 7"></polyline>
                    <line x1="15" y1="12" x2="3" y2="12"></line>
                  </svg>
                  Sign In
                </>
              )}
            </button>
          </form>
        </div>

        {/* Global notifications toaster container */}
        <div className="toast-container">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.type} show`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                  {toast.type === 'success' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  )}
                  {toast.type === 'error' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                  )}
                  {toast.type === 'info' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                  )}
                </span>
                <span className="toast-content">{toast.message}</span>
              </div>
              <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const getHeaderContent = () => {
    switch (activeView) {
      case 'outreach':
        return {
          meta: "Campaigns & Ingestion",
          title: "Outreach Dashboard",
          subtitle: "Upload student directories via Excel, trigger template broadcasts, and track real-time delivery conversion rates."
        };
      case 'chat':
        return {
          meta: "Live Support & Notes",
          title: "Live Chat & Counselor Inbox",
          subtitle: "Communicate directly with parents, review automated bot history, and manage internal counselor follow-up notes."
        };
      case 'bot-builder':
        return {
          meta: "Automation Engine",
          title: "Visual Auto-Bot Flow Builder",
          subtitle: "Design parent interactive response paths, configure button callbacks, and edit direct messaging scripts."
        };
      case 'reminders':
        return {
          meta: "Scheduled Reminders & Calls",
          title: "Scheduled Call Reminders",
          subtitle: "View and manage all parent requests for calls, including specific scheduled time slots."
        };
      case 'contacts':
        return {
          meta: "Student Registry",
          title: "Contacts Directory",
          subtitle: "Manage parent database records, add individual candidates, and view contact details."
        };
      default:
        return {
          meta: "WhatsApp Automation Portal",
          title: "WhatsApp Automation Engine",
          subtitle: "Manage parent communications and automated outreach channels."
        };
    }
  };

  const header = getHeaderContent();

  return (
    <div className={`app-wrapper mobile-view-${mobileActiveSubView}`}>
      {/* Backdrop overlay for mobile drawer */}
      {isSidebarOpen && (
        <div 
          className="sidebar-backdrop"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
      {/* 1. Left Sidebar Navigation */}
      <aside 
        className={`app-sidebar ${isSidebarOpen ? 'mobile-open' : ''}`}
        style={{ 
          width: isSidebarOpen ? '280px' : '72px',
          minWidth: isSidebarOpen ? '280px' : '72px',
          transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      >
        <div 
          className="sidebar-header" 
          style={{ 
            display: 'flex', 
            justifyContent: isSidebarOpen ? 'space-between' : 'center', 
            alignItems: 'center', 
            padding: isSidebarOpen ? '0 1.5rem' : '0 0.5rem' 
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div 
              className="sidebar-logo" 
              style={{ cursor: isSidebarOpen ? 'default' : 'pointer' }} 
              onClick={() => !isSidebarOpen && setIsSidebarOpen(true)} 
              title={!isSidebarOpen ? "Expand Sidebar" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            {isSidebarOpen && <span className="sidebar-brand-title">WhatsApp Automation</span>}
          </div>
          {isSidebarOpen && (
            <button 
              onClick={() => setIsSidebarOpen(false)}
              title="Collapse Sidebar"
              style={{ 
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontSize: '1.1rem',
                display: 'flex',
                alignItems: 'center',
                padding: '0.25rem'
              }}
            >
              ⇤
            </button>
          )}
        </div>

        <nav className="sidebar-menu" style={{ padding: isSidebarOpen ? '1.5rem 0.75rem' : '1.5rem 0.5rem' }}>
          {currentUser?.role === 'super_admin' && (
            <button 
              className={`sidebar-menu-item ${activeView === 'outreach' ? 'active' : ''}`}
              onClick={() => navigateToView('outreach')}
              style={{ 
                justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
                padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0' 
              }}
              title={!isSidebarOpen ? "Outreach Dashboard" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
              {isSidebarOpen && <span>Outreach Dashboard</span>}
            </button>
          )}

          <button 
            className={`sidebar-menu-item ${activeView === 'chat' ? 'active' : ''}`}
            onClick={() => navigateToView('chat')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0',
              position: 'relative'
            }}
            title={!isSidebarOpen ? (currentUser?.role === 'counselor' ? "My Assigned Chats" : "Inbox") : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            {isSidebarOpen && <span>{currentUser?.role === 'counselor' ? "My Assigned Chats" : "Inbox"}</span>}
            {(() => {
              const count = chatsList.reduce((acc, chat) => acc + (chat.record.unread_count || 0), 0);
              return count > 0 ? (
                <span className="badge-notification" style={{
                  backgroundColor: 'var(--color-blue)',
                  color: '#fff',
                  borderRadius: '50%',
                  minWidth: '18px',
                  height: '18px',
                  fontSize: '0.7rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 'bold',
                  marginLeft: isSidebarOpen ? 'auto' : '0',
                  position: isSidebarOpen ? 'static' : 'absolute',
                  top: isSidebarOpen ? 'auto' : '4px',
                  right: isSidebarOpen ? 'auto' : '4px',
                  padding: '0 4px',
                  boxShadow: '0 2px 4px rgba(37, 99, 235, 0.3)'
                }}>
                  {count}
                </span>
              ) : null;
            })()}
          </button>
 
          {currentUser?.role === 'super_admin' && (
            <>
              <button 
                className={`sidebar-menu-item ${activeView === 'bot-builder' ? 'active' : ''}`}
                onClick={() => navigateToView('bot-builder')}
                style={{ 
                  justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
                  padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0' 
                }}
                title={!isSidebarOpen ? "Visual Bot Builder" : undefined}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="9" y1="3" x2="9" y2="21"></line>
                  <line x1="9" y1="12" x2="21" y2="12"></line>
                </svg>
                {isSidebarOpen && <span>Visual Bot Builder</span>}
              </button>            </>
          )}
 
          <button 
            className={`sidebar-menu-item ${activeView === 'reminders' ? 'active' : ''}`}
            onClick={() => navigateToView('reminders')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0',
              position: 'relative'
            }}
            title={!isSidebarOpen ? (currentUser?.role === 'counselor' ? "My Scheduled Reminders" : "Scheduled Reminders") : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            {isSidebarOpen && <span>{currentUser?.role === 'counselor' ? "My Scheduled Reminders" : "Scheduled Reminders"}</span>}
            {reminders.length > 0 && (
              <span className="badge-notification" style={{
                backgroundColor: 'var(--color-coral)',
                color: '#fff',
                borderRadius: '50%',
                minWidth: '18px',
                height: '18px',
                fontSize: '0.7rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                marginLeft: isSidebarOpen ? 'auto' : '0',
                position: isSidebarOpen ? 'static' : 'absolute',
                top: isSidebarOpen ? 'auto' : '4px',
                right: isSidebarOpen ? 'auto' : '4px',
                padding: '0 4px',
                boxShadow: '0 2px 4px rgba(239, 68, 68, 0.3)'
              }}>
                {reminders.length}
              </span>
            )}
          </button>
 
          {currentUser?.role === 'super_admin' && (
            <button 
              className={`sidebar-menu-item ${activeView === 'contacts' ? 'active' : ''}`}
              onClick={() => {
                navigateToView('contacts');
                setContactsPage(1);
                fetchContacts(1);
              }}
              style={{ 
                justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
                padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0',
                position: 'relative'
              }}
              title={!isSidebarOpen ? "Contacts Directory" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
              {isSidebarOpen && <span>Contacts Directory</span>}
            </button>
          )}

          {currentUser?.role === 'super_admin' && (
            <button 
              className={`sidebar-menu-item ${activeView === 'team' ? 'active' : ''}`}
              onClick={() => {
                navigateToView('team');
                fetchTeamUsers();
              }}
              style={{ 
                justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
                padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0',
                position: 'relative'
              }}
              title={!isSidebarOpen ? "Team & Staff" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="8.5" cy="7" r="4"></circle>
                <line x1="20" y1="8" x2="20" y2="14"></line>
                <line x1="17" y1="11" x2="23" y2="11"></line>
              </svg>
              {isSidebarOpen && <span>Team & Staff</span>}
            </button>
          )}
        </nav>

        <div className="sidebar-footer" style={{ padding: isSidebarOpen ? '1.25rem 1rem' : '1.25rem 0.5rem', alignItems: 'center' }}>
          <div className="sidebar-user-info" style={{ justifyContent: isSidebarOpen ? 'flex-start' : 'center', width: '100%', gap: isSidebarOpen ? '0.75rem' : '0' }}>
            <div className="sidebar-user-avatar" title={!isSidebarOpen ? (currentUser?.full_name || "User") : undefined}>
              {currentUser?.full_name ? currentUser.full_name[0].toUpperCase() : 'A'}
            </div>
            {isSidebarOpen && (
              <div className="sidebar-user-details">
                <span className="sidebar-user-name">{currentUser?.full_name || 'Administrator'}</span>
                <span className="sidebar-user-role" style={{ textTransform: 'capitalize' }}>
                  {currentUser?.role ? currentUser.role.replace('_', ' ') : 'System Admin'}
                </span>
              </div>
            )}
          </div>

          <button 
            onClick={() => {
              setChangePasswordError('');
              setIsChangePasswordOpen(true);
            }} 
            className="btn btn-secondary btn-sidebar-password"
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center',
              padding: isSidebarOpen ? '0.5rem 1rem' : '0.5rem 0',
              marginTop: '0.75rem' 
            }}
            title={!isSidebarOpen ? "Change Password" : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: isSidebarOpen ? '6.6px' : '0' }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            {isSidebarOpen && "Change Password"}
          </button>

          <button 
            onClick={handleLogout} 
            className="btn btn-secondary btn-sidebar-logout"
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center',
              padding: isSidebarOpen ? '0.5rem 1rem' : '0.5rem 0',
              marginTop: '0.75rem' 
            }}
            title={!isSidebarOpen ? "Sign Out" : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: isSidebarOpen ? '6.6px' : '0' }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            {isSidebarOpen && "Sign Out"}
          </button>
        </div>
      </aside>

      {/* 2. Main Content View Area */}
      <main className="app-content" tabIndex={0} style={{ outline: 'none' }}>
        
        {/* Header Title Bar */}
        <header className="dashboard-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%' }}>
            {/* Hamburger button on mobile */}
            <button 
              className="mobile-menu-toggle"
              onClick={() => setIsSidebarOpen(true)}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                padding: '0.25rem',
                color: 'var(--text-primary)',
                display: 'none',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title="Open Navigation Menu"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            <div className="header-titles">
              <span className="header-meta">{header.meta}</span>
              <h1>{header.title}</h1>
              <p className="subtitle">{header.subtitle}</p>
            </div>
          </div>
        </header>

        <div style={{ display: activeView === 'outreach' ? 'flex' : 'none', flexDirection: 'column', gap: '2rem' }}>
            {/* Analytics statistical counters grid */}
            <section className="analytics-grid">
          <div className="stat-card">
            <div className="stat-icon icon-blue">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Total Uploaded</span>
              <h3 className="stat-value">{stats.total.toLocaleString()}</h3>
              <p className="stat-desc">Parents in database</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-purple">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Campaign Sent</span>
              <h3 className="stat-value">{stats.sent.toLocaleString()}</h3>
              <p className="stat-desc">{stats.unsent.toLocaleString()} unsent/pending</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Read / Seen</span>
              <h3 className="stat-value">{stats.read.toLocaleString()}</h3>
              <p className="stat-desc">{readRate}% read conversion</p>
            </div>
          </div>

          {/* Removed Interested and Not Interested stats cards to simplify display */}

          <div className="stat-card">
            <div className="stat-icon" style={{ backgroundColor: 'var(--color-coral-light)', border: '1px solid var(--color-coral-border)', color: 'var(--color-coral)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Delivery Failed</span>
              <h3 className="stat-value">{(stats.failed || 0).toLocaleString()}</h3>
              <p className="stat-desc">Requires manual retry</p>
            </div>
          </div>
        </section>

        {/* Interactive Funnel Analytics Panel */}
        <section className="glass-panel analytics-funnel-card" style={{ padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--color-text-dark)', margin: 0 }}>Interactive Conversion Funnel</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', margin: '2px 0 0 0' }}>Track candidates from initial dispatch to successful enrollment</p>
            </div>
            <div style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', borderRadius: '20px', backgroundColor: 'var(--color-blue-light)', color: 'var(--color-blue)', fontWeight: '600' }}>
              Real-time Flow Analysis
            </div>
          </div>
          
          <div className="funnel-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {(() => {
              const baseValue = stats.sent || 1;
              const steps = [
                { label: "Sent Outreach Messages", value: stats.sent, color: "var(--color-purple)", desc: "Campaign broadcasts successfully dispatched" },
                { label: "Delivered to Device", value: stats.delivered || 0, color: "var(--color-blue)", desc: "Received on parent's phone" },
                { label: "Read / Opened", value: stats.read, color: "var(--color-amber)", desc: "Opened and viewed by recipient" },
                { label: "Replied / Inbound", value: stats.replied || 0, color: "var(--color-coral)", desc: "Engaged in conversation" }
              ];
              
              return steps.map((step, idx) => {
                const prevStep = idx > 0 ? steps[idx - 1] : null;
                const prevValue = prevStep ? prevStep.value : baseValue;
                
                const overallPct = stats.sent > 0 ? ((step.value / stats.sent) * 100).toFixed(1) : '0.0';
                const stepPct = prevValue > 0 ? ((step.value / prevValue) * 100).toFixed(1) : '0.0';
                
                return (
                  <div key={idx} className="funnel-step" style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%', padding: '0.5rem', borderRadius: '8px' }}>
                    <div style={{ width: '180px', display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--color-text-dark)' }}>{step.label}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>{step.desc}</span>
                    </div>
                    <div style={{ flexGrow: 1, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flexGrow: 1, height: '18px', backgroundColor: '#f1f5f9', borderRadius: '9px', overflow: 'hidden', position: 'relative' }}>
                        <div style={{ 
                          width: `${step.value > 0 ? Math.min(100, Math.max(1, (step.value / baseValue) * 100)) : 0}%`, 
                          height: '100%', 
                          backgroundColor: step.color,
                          borderRadius: '9px',
                          transition: 'width 0.6s ease'
                        }} />
                        <span style={{ 
                          position: 'absolute', 
                          left: '10px', 
                          top: '50%', 
                          transform: 'translateY(-50%)', 
                          fontSize: '0.7rem', 
                          fontWeight: '700', 
                          color: (step.value / baseValue) * 100 > 15 ? 'white' : 'var(--color-text-dark)'
                        }}>
                          {step.value.toLocaleString()}
                        </span>
                      </div>
                      <div style={{ width: '120px', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          Step: <strong style={{ color: 'var(--color-text-dark)' }}>{stepPct}%</strong>
                        </span>
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          Total: <strong style={{ color: 'var(--color-text-dark)' }}>{overallPct}%</strong>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </section>

        {/* File Ingestion & Campaign Control Cards */}
        <section className="control-center">
          
          {/* File Upload Panel (Left Side) */}
          <div className="glass-panel upload-panel">
            <div className="panel-header">
              <h4>Excel Ingestion Engine</h4>
            </div>

            {parsedColumns.length === 0 ? (
              <div 
                className={`drop-zone ${dragActive ? 'dragover' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current.click()}
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  accept=".xlsx,.csv" 
                  className="hidden-input"
                  onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0])}
                />
                <div className="drop-zone-content">
                  <svg className="upload-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <p className="upload-title">Drag & drop spreadsheet here</p>
                  <p className="upload-subtitle">Supports .xlsx or .csv up to 2,000 numbers</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => {e.stopPropagation(); fileInputRef.current.click();}}>Browse Files</button>
                </div>
              </div>
            ) : (
              <div className="columns-display-container">
                <div className="columns-display-header">
                  <h5>Spreadsheet Columns Parsed</h5>
                  <p className="columns-desc">The following headers were auto-mapped from your file:</p>
                </div>
                <div className="parsed-columns-list">
                  {parsedColumns.map((col, idx) => (
                    <span key={idx} className="column-pill">{col}</span>
                  ))}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetUploader} style={{marginTop: 'auto', width: '100%'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  Upload Another Spreadsheet
                </button>
              </div>
            )}

            {uploading && (
              <div className="upload-progress-container">
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }}></div>
                </div>
                <p className="progress-text">{uploadStatusText}</p>
              </div>
            )}
          </div>

          {/* Campaign Controls (Right Side - Customizable Template) */}
          <div className="glass-panel campaign-panel">
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h4>Campaign Control Center</h4>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  onClick={() => setShowAddTemplateInput(!showAddTemplateInput)} 
                  className="btn btn-secondary btn-sm" 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                >
                  ➕ Add Template
                </button>
                <button 
                  onClick={handleSyncTemplates} 
                  className="btn btn-secondary btn-sm" 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  disabled={syncingTemplates}
                >
                  {syncingTemplates ? 'Syncing...' : '🔄 Sync Templates'}
                </button>
              </div>
            </div>
            
            {showAddTemplateInput && (
              <div style={{
                padding: '0.75rem 1rem',
                borderBottom: '1px solid var(--border-color)',
                backgroundColor: 'rgba(255, 255, 255, 0.02)',
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center'
              }}>
                <input 
                  type="text" 
                  placeholder="Template Name (e.g. parent_outreach)" 
                  className="filter-select"
                  style={{ flex: 1, height: '32px', fontSize: '0.8rem' }}
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  disabled={addingTemplate}
                />
                <button 
                  onClick={handleAddTemplate} 
                  className="btn btn-primary btn-sm"
                  style={{ height: '32px', fontSize: '0.75rem' }}
                  disabled={addingTemplate}
                >
                  {addingTemplate ? 'Adding...' : 'Fetch'}
                </button>
                <button 
                  onClick={() => { setShowAddTemplateInput(false); setNewTemplateName(''); }} 
                  className="btn btn-secondary btn-sm"
                  style={{ height: '32px', fontSize: '0.75rem' }}
                  disabled={addingTemplate}
                >
                  Cancel
                </button>
              </div>
            )}
            
            {mediaFileMissing && mediaType !== 'none' && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                margin: '0.75rem 1rem 0.25rem 1rem',
                fontSize: '0.75rem',
                color: 'var(--color-coral)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                lineHeight: '1.4'
              }}>
                <span style={{ fontSize: '1.25rem' }}>⚠️</span>
                <span>
                  <strong>Outreach image/media not found on the server.</strong> <br />
                  The previous server session ended or the container was restarted. Please <strong>re-upload</strong> the file or <strong>paste a valid URL</strong> below to restore it before launching campaigns.
                </span>
              </div>
            )}
            
            <div className="campaign-desc-container">
              <div className="template-editor-group">
                <div className="editor-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <label htmlFor="template-selector" className="editor-label" style={{ marginBottom: 0 }}>Template:</label>
                    <select
                      id="template-selector"
                      className="filter-select"
                      style={{ padding: '0.25rem 2rem 0.25rem 0.75rem', height: '32px', fontSize: '0.85rem' }}
                      value={selectedTemplateName}
                      onChange={(e) => handleTemplateChange(e.target.value)}
                    >
                      {templatesList.map(t => (
                        <option key={t.template_name} value={t.template_name}>
                          {t.template_name}
                        </option>
                      ))}
                    </select>
                    {templatesList.find(t => t.template_name === selectedTemplateName)?.is_active ? (
                      <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', borderRadius: '4px', background: 'rgba(46, 204, 113, 0.2)', color: '#2ecc71', border: '1px solid rgba(46, 204, 113, 0.4)' }}>
                        Active
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', borderRadius: '4px', background: 'rgba(241, 196, 15, 0.2)', color: '#f1c40f', border: '1px solid rgba(241, 196, 15, 0.4)' }}>
                        Inactive
                      </span>
                    )}
                  </div>
                  <button 
                    onClick={handleSaveTemplate} 
                    className="btn btn-secondary btn-sm" 
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    disabled={saveStatus === 'saving'}
                  >
                    {saveStatus === 'saving' ? 'Saving...' : 'Save Media Settings'}
                  </button>
                </div>
                
                <textarea 
                  id="template-editor-textarea" 
                  className="template-editor" 
                  rows={4} 
                  placeholder="Dear [Parent Name], your child [Student Name]..."
                  value={templateText}
                  readOnly={true}
                  style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', color: 'var(--color-text-muted)', cursor: 'not-allowed' }}
                />
                
                <div className="editor-help-text" style={{ opacity: 0.7 }}>
                  ⚠️ Meta templates are pre-approved and read-only.
                </div>

                {/* Media Attachment Selector */}
                {mediaType !== 'none' && (
                  <div className="media-selector-group" style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                    <span className="editor-label" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.75rem' }}>
                      Outreach Media Attachment ({mediaType === 'image' ? 'Image Required' : 'Document Required'})
                    </span>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {!mediaUrl ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input 
                            type="file" 
                            accept={mediaType === 'image' ? "image/*" : ".pdf,.docx,.xlsx"} 
                            onChange={handleMediaUpload} 
                            style={{ display: 'none' }} 
                            id="media-file-input" 
                          />
                          <button 
                            type="button" 
                            className="btn btn-secondary btn-sm" 
                            onClick={() => document.getElementById('media-file-input').click()}
                            disabled={mediaUploading}
                          >
                            {mediaUploading ? 'Uploading...' : `Upload ${mediaType === 'image' ? 'Image' : 'Document'}`}
                          </button>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            Or paste a public URL below:
                          </span>
                        </div>
                      ) : (
                        <div className="column-pill" style={{ width: 'max-content', paddingRight: '0.5rem' }}>
                          <span style={{ wordBreak: 'break-all' }}>{mediaFilename || 'Attachment uploaded'}</span>
                          <button 
                            type="button" 
                            style={{ background: 'none', border: 'none', color: 'var(--color-coral)', cursor: 'pointer', fontWeight: 'bold', marginLeft: '0.5rem' }}
                            onClick={() => { setMediaUrl(null); setMediaFilename(''); setSaveStatus('unsaved'); }}
                          >
                            &times;
                          </button>
                        </div>
                      )}
                      
                      <input 
                        type="text" 
                        placeholder={mediaType === 'image' ? "https://example.com/image.jpg" : "https://example.com/fees.pdf"}
                        value={mediaUrl || ''}
                        onChange={(e) => { setMediaUrl(e.target.value); setMediaFilename(e.target.value.split('/').pop()); setSaveStatus('unsaved'); }}
                        className="template-editor"
                        style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                      />
                    </div>
                  </div>
                )}
              </div>
              
              <div className="message-preview">
                <div className="preview-header">
                  <span className="preview-label">Compiled Message Preview (Sample Record)</span>
                  <span className={`save-status-indicator ${saveStatus === 'unsaved' ? 'unsaved' : 'synced'}`}>
                    {saveStatus === 'unsaved' ? 'Unsaved Changes' : 'Synced'}
                  </span>
                </div>

                {/* Media Preview Box */}
                {mediaType !== 'none' && mediaUrl && (
                  <div style={{ marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', display: 'flex', justifyContent: 'center', backgroundColor: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                    {mediaType === 'image' ? (
                      <img 
                        src={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                        alt="Preview" 
                        style={{ maxWidth: '100%', maxHeight: '150px', objectFit: 'contain' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', backgroundColor: '#ffffff', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '0.813rem', width: '90%' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-coral)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <span style={{ fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
                          {mediaFilename || 'document.pdf'}
                        </span>
                        <a 
                          href={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                          target="_blank" 
                          rel="noreferrer"
                          style={{ fontSize: '0.75rem', color: 'var(--color-blue)', textDecoration: 'none', fontWeight: 'bold' }}
                        >
                          View File
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <p className="preview-body">
                  {renderLivePreviewText()}
                </p>
              </div>
            </div>

            {/* Template variable requirement checklist & spreadsheet warning */}
            {requiredFields.length > 0 ? (
              <div style={{ margin: '0rem 1rem 0.75rem 1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                  Required template variables:
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {requiredFields.map(f => {
                    const isMissing = missingFields.includes(f);
                    return (
                      <span 
                        key={f} 
                        style={{ 
                          fontSize: '0.7rem', 
                          padding: '0.15rem 0.4rem', 
                          borderRadius: '4px', 
                          background: isMissing ? 'rgba(239, 68, 68, 0.15)' : 'rgba(46, 204, 113, 0.15)', 
                          color: isMissing ? '#fc8181' : '#2ecc71',
                          border: isMissing ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(46, 204, 113, 0.3)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem'
                        }}
                      >
                        {isMissing ? '❌' : '✅'} {f}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'rgba(46, 204, 113, 0.8)', margin: '0rem 1rem 0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span>✅ Static template (no variables required). Can send directly.</span>
              </div>
            )}

            {missingFields.length > 0 && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                margin: '0rem 1rem 0.75rem 1rem',
                fontSize: '0.75rem',
                color: '#fc8181',
                lineHeight: '1.4'
              }}>
                <strong>⚠️ Spreadsheet Header Mismatch</strong> <br />
                Your uploaded spreadsheet is missing columns for: <strong>{missingFields.join(', ')}</strong>. Please upload a spreadsheet with the matching headers to send.
              </div>
            )}

            <div className="campaign-actions" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.25rem 0.5rem', background: '#f8fafc', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  Target Audience:
                </span>
                <div style={{ display: 'flex', gap: '4px', background: '#e2e8f0', padding: '2px', borderRadius: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setCampaignRecipient('parent')}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: campaignRecipient === 'parent' ? '#ffffff' : 'transparent',
                      color: campaignRecipient === 'parent' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: campaignRecipient === 'parent' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    Parents
                  </button>
                  <button
                    type="button"
                    onClick={() => setCampaignRecipient('student')}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: campaignRecipient === 'student' ? '#ffffff' : 'transparent',
                      color: campaignRecipient === 'student' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: campaignRecipient === 'student' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    Students
                  </button>
                </div>
              </div>
              <button 
                onClick={handleLaunchBroadcast} 
                className="btn btn-primary btn-lg btn-block"
                disabled={missingFields.length > 0}
                style={{
                  cursor: missingFields.length > 0 ? 'not-allowed' : 'pointer',
                  opacity: missingFields.length > 0 ? 0.6 : 1
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Launch Broadcast Campaign {stats.unsent > 0 ? `(${stats.unsent} pending)` : ''}
              </button>
            </div>
          </div>
        </section>

        {/* Data Table Filters & Grid Panel */}
        <section className="glass-panel grid-panel">
          <div className="grid-panel-header">
            <div className="funnel-filter-bar">
              <div className="filter-group">
                <span className="filter-label">1. Dispatch</span>
                <select 
                  value={dispatchFilter} 
                  onChange={(e) => handleDispatchFilterChange(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Dispatch States</option>
                  <option value="unsent">Unsent (Pending)</option>
                  <option value="sent">Sent</option>
                  <option value="failed">Failed</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">2. Delivery</span>
                <select 
                  value={deliveryFilter} 
                  onChange={(e) => handleDeliveryFilterChange(e.target.value)} 
                  className="filter-select"
                  disabled={dispatchFilter !== 'sent'}
                >
                  <option value="all">All Delivery States</option>
                  <option value="pending">Pending</option>
                  <option value="delivered">Delivered</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">3. Read Status</span>
                <select 
                  value={readFilter} 
                  onChange={(e) => handleReadFilterChange(e.target.value)} 
                  className="filter-select"
                  disabled={dispatchFilter !== 'sent' || deliveryFilter !== 'delivered'}
                >
                  <option value="all">All Read States</option>
                  <option value="not_read">Not Read</option>
                  <option value="read">Read</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">Branch</span>
                <select 
                  value={branchFilter} 
                  onChange={(e) => setBranchFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Branches</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">Template</span>
                <select 
                  value={templateFilter} 
                  onChange={(e) => setTemplateFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Templates</option>
                  {templatesList.map((t) => (
                    <option key={t.template_name} value={t.template_name}>{t.template_name}</option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">Target Audience</span>
                <div style={{ display: 'flex', gap: '4px', background: '#e2e8f0', padding: '2px', borderRadius: '6px', height: '36px', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => setCampaignRecipient('parent')}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 12px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: campaignRecipient === 'parent' ? '#ffffff' : 'transparent',
                      color: campaignRecipient === 'parent' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: campaignRecipient === 'parent' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    Parents
                  </button>
                  <button
                    type="button"
                    onClick={() => setCampaignRecipient('student')}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 12px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: campaignRecipient === 'student' ? '#ffffff' : 'transparent',
                      color: campaignRecipient === 'student' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: campaignRecipient === 'student' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    Students
                  </button>
                </div>
              </div>
            </div>

            <div className="grid-header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="search-container">
                <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input 
                  type="text" 
                  placeholder="Search student, parent, phone..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button 
                onClick={handleExportExcel} 
                className="btn btn-success"
                style={{ height: '38px', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap', padding: '0.5rem 1rem' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Export Excel
              </button>
            </div>
          </div>

          {selectedRecordIds.length > 0 && (
            <div className="bulk-action-bar" style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1.25rem',
              margin: '0.75rem 1.5rem',
              animation: 'fadeIn 0.2s ease-in-out'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#1e40af', fontWeight: '600', fontSize: '0.875rem' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>{selectedRecordIds.length} candidate(s) selected for bulk outreach</span>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button 
                  onClick={handleBulkSend} 
                  className="btn btn-primary btn-sm"
                  style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    cursor: missingFields.length > 0 ? 'not-allowed' : 'pointer',
                    opacity: missingFields.length > 0 ? 0.6 : 1
                  }}
                  disabled={missingFields.length > 0}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  Send Outreach
                </button>
                <button 
                  onClick={() => setSelectedRecordIds([])} 
                  className="btn btn-secondary btn-sm"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          <div className="table-container">
            <div style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid var(--border-color)',
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              {templateFilter === 'all' ? (
                <span>Showing delivery status across all templates</span>
              ) : (
                <span>Showing delivery status specifically for template: <strong>{templateFilter}</strong></span>
              )}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input 
                      type="checkbox" 
                      style={{ 
                        cursor: records.filter(isRecordEligibleForBulk).length > 0 ? 'pointer' : 'not-allowed', 
                        scale: '1.1' 
                      }}
                      checked={
                        records.length > 0 && 
                        records.filter(isRecordEligibleForBulk).length > 0 &&
                        records.filter(isRecordEligibleForBulk).every(r => selectedRecordIds.includes(r.id))
                      }
                      disabled={records.filter(isRecordEligibleForBulk).length === 0}
                      onChange={(e) => {
                        const eligiblePageIds = records.filter(isRecordEligibleForBulk).map(r => r.id);
                        if (e.target.checked) {
                          setSelectedRecordIds(prev => [...new Set([...prev, ...eligiblePageIds])]);
                        } else {
                          setSelectedRecordIds(prev => prev.filter(id => !eligiblePageIds.includes(id)));
                        }
                      }}
                    />
                  </th>
                  <th>Student Details</th>
                  <th>Parent Details</th>
                  <th>Branch</th>
                  <th>Sent Template</th>
                  <th>Student Phone</th>
                  <th>Parent Phone</th>
                  <th>Dispatch</th>
                  <th>Delivery</th>
                  <th>Read Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {gridLoading ? (
                  <tr className="state-loading">
                    <td colSpan={10}>
                      <div className="loading-spinner-container">
                        <div className="spinner"></div>
                        <span>Loading records...</span>
                      </div>
                    </td>
                  </tr>
                ) : gridError ? (
                  <tr className="state-empty">
                    <td colSpan={10}>
                      <div className="empty-container">
                        <svg className="empty-icon text-coral" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                          <line x1="12" y1="9" x2="12" y2="13"></line>
                          <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <span className="empty-title text-coral">Data Query Failed</span>
                        <span className="empty-desc">{gridError}</span>
                      </div>
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr className="state-empty">
                    <td colSpan={10}>
                      <div className="empty-container">
                        <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="8" x2="12" y2="12"></line>
                          <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <span className="empty-title">No Records Found</span>
                        <span className="empty-desc">Upload an Excel or adjust filters to populate contacts.</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  records.map((rec) => {


                    return (
                      <tr key={rec.id}>
                        <td style={{ textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            style={{ 
                              cursor: isRecordEligibleForBulk(rec) ? 'pointer' : 'not-allowed',
                              opacity: isRecordEligibleForBulk(rec) ? 1 : 0.5
                            }}
                            checked={selectedRecordIds.includes(rec.id)}
                            disabled={!isRecordEligibleForBulk(rec)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRecordIds(prev => [...prev, rec.id]);
                              } else {
                                setSelectedRecordIds(prev => prev.filter(id => id !== rec.id));
                              }
                            }}
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span className="cell-title">{rec.student_name}</span>
                            {rec.unresolved_notes_count > 0 && (
                              <span 
                                title={`${rec.unresolved_notes_count} pending notes/actions`} 
                                style={{
                                  backgroundColor: '#fffbeb',
                                  color: '#d97706',
                                  border: '1px solid #fde68a',
                                  borderRadius: '50%',
                                  width: '18px',
                                  height: '18px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '0.7rem',
                                  fontWeight: 'bold',
                                  cursor: 'help'
                                }}
                              >
                                📝
                              </span>
                            )}
                          </div>
                          <span className="cell-subtitle">ID: {rec.id}</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.parent_name}</span>
                          <span className="cell-subtitle">Parent</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.selected_branch}</span>
                        </td>
                        <td>
                          <span className="cell-title" style={{ fontSize: '0.8rem', opacity: rec.sent_template ? 1 : 0.5 }}>
                            {rec.sent_template || '—'}
                          </span>
                        </td>
                        <td>
                          <span className="cell-title">📱 +{rec.phone_number}</span>
                        </td>
                        <td>
                          {rec.parent_phone_number ? (
                            <span className="cell-title">📱 +{rec.parent_phone_number}</span>
                          ) : (
                            <span className="cell-subtitle" style={{ fontStyle: 'italic', opacity: 0.5 }}>N/A</span>
                          )}
                        </td>
                        {/* 1. Dispatch Column */}
                        <td>
                          {(() => {
                            const status = (rec.delivery_status || 'Unsent').toLowerCase();
                            if (status === 'unsent') {
                              return <span className="badge badge-unsent"><span className="badge-dot"></span>UNSENT</span>;
                            } else if (status === 'failed') {
                              return <span className="badge badge-failed"><span className="badge-dot"></span>FAILED</span>;
                            } else {
                              return <span className="badge badge-sent"><span className="badge-dot"></span>SENT</span>;
                            }
                          })()}
                        </td>

                        {/* 2. Delivery Column */}
                        <td>
                          {(() => {
                            const status = (rec.delivery_status || 'Unsent').toLowerCase();
                            if (status === 'unsent' || status === 'failed') {
                              return <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>—</span>;
                            } else if (status === 'sent') {
                              return <span className="badge badge-pending"><span className="badge-dot"></span>PENDING</span>;
                            } else {
                              return <span className="badge badge-delivered"><span className="badge-dot"></span>DELIVERED</span>;
                            }
                          })()}
                        </td>

                        {/* 3. Read Status Column */}
                        <td>
                          {(() => {
                            const status = (rec.delivery_status || 'Unsent').toLowerCase();
                            if (status === 'read') {
                              return <span className="badge badge-read"><span className="badge-dot"></span>READ</span>;
                            } else if (status === 'delivered') {
                              return <span className="badge badge-unsent"><span className="badge-dot"></span>UNREAD</span>;
                            } else {
                              return <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>—</span>;
                            }
                          })()}
                        </td>
                        <td className="text-right">
                          <div className="table-actions">
                            <button 
                              onClick={() => handleSendSingle(rec.id)} 
                              className="btn btn-secondary btn-sm"
                              disabled={rec.parent_response === 'Interested' || missingFields.length > 0}
                              title={
                                rec.parent_response === 'Interested' 
                                  ? "Parent has confirmed interest" 
                                  : (missingFields.length > 0 ? "Spreadsheet is missing required headers" : `${rec.campaign_status === 'Pending' ? 'Send' : 'Resend'} to ${campaignRecipient === 'parent' ? 'Parent' : 'Student'}`)
                              }
                            >
                              {rec.campaign_status === 'Pending' ? 'Send' : 'Resend'}
                            </button>

                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Footer */}
          <div className="grid-footer">
            <span className="footer-text">
              Showing {records.length === 0 ? 0 : (currentPage - 1) * RECORDS_PER_PAGE + 1} to{' '}
              {Math.min(currentPage * RECORDS_PER_PAGE, totalCount)} of {totalCount} records
            </span>
            <div className="pagination-controls">
              <button 
                onClick={() => changePage(-1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage <= 1}
              >
                Previous
              </button>
              <span className="page-indicator">Page {currentPage} of {totalPages || 1}</span>
              <button 
                onClick={() => changePage(1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </section>
        </div>

        <div className={`chat-container ${currentUser?.role === 'counselor' ? 'counselor-layout' : ''}`} style={{ display: activeView === 'chat' ? 'grid' : 'none' }}>
            {/* 1. Recent Chats List Pane */}
            <div className="glass-panel chat-list-panel">
              <div className="chat-search-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', width: '100%' }}>
                  <input 
                    type="text" 
                    placeholder="Search student, phone..." 
                    className="chat-search-input"
                    value={chatSearchText}
                    onChange={(e) => setChatSearchText(e.target.value)}
                    style={{ flexGrow: 1 }}
                  />
                  <button 
                    className="btn btn-secondary btn-sm mobile-only-flex" 
                    onClick={() => setMobileActiveSubView('rules')}
                    style={{ whiteSpace: 'nowrap', padding: '0.5rem' }}
                  >
                    🤖 Rules
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
                  <select 
                    className="filter-select" 
                    style={{ flex: 1, padding: '0.45rem 0.75rem', fontSize: '0.813rem', height: '34px', minWidth: 0 }}
                    value={chatBranchFilter}
                    onChange={(e) => setChatBranchFilter(e.target.value)}
                  >
                    <option value="all">All Branches</option>
                    {branches.map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>

                  <select 
                    className="filter-select" 
                    style={{ flex: 1, padding: '0.45rem 0.75rem', fontSize: '0.813rem', height: '34px', minWidth: 0 }}
                    value={chatStatusFilter}
                    onChange={(e) => {
                      const val = e.target.value;
                      setChatStatusFilter(val);
                      fetchRecentChats(val === 'completed' ? 'resolved' : 'active');
                    }}
                  >
                    <option value="all">All Active Chats</option>
                    <option value="unread">Unread Messages</option>
                    <option value="unreplied">Unreplied (Needs Action)</option>
                    <option value="completed">🟢 Resolved / Completed Chats</option>
                    <optgroup label="Pipeline Stage">
                      <option value="stage:Lead">Stage: Lead</option>
                      <option value="stage:Contacted">Stage: Contacted</option>
                      <option value="stage:Interested">Stage: Interested</option>
                      <option value="stage:Not Interested">Stage: Not Interested</option>
                      <option value="stage:Enrolled">Stage: Enrolled</option>
                    </optgroup>
                  </select>
                </div>
              </div>
              <div className="conversations-scrollable">
                {chatsList.filter(chat => {
                  const matchSearch = chat.record.student_name.toLowerCase().includes(chatSearchText.toLowerCase()) ||
                                      chat.record.phone_number.includes(chatSearchText) ||
                                      (chat.record.parent_name && chat.record.parent_name.toLowerCase().includes(chatSearchText.toLowerCase()));
                  const matchBranch = chatBranchFilter === 'all' || chat.record.selected_branch === chatBranchFilter;
                  
                  let matchStatus = true;
                  const lastMsg = chat.last_message;
                  
                  if (chatStatusFilter === 'unread') {
                    matchStatus = (chat.record.unread_count || 0) > 0;
                  } else if (chatStatusFilter === 'unreplied') {
                    matchStatus = lastMsg && lastMsg.sender === 'parent';
                  } else if (chatStatusFilter.startsWith('stage:')) {
                    const targetStage = chatStatusFilter.split('stage:')[1];
                    matchStatus = (chat.record.pipeline_tag || 'Lead').toLowerCase() === targetStage.toLowerCase();
                  }
                  
                  return matchSearch && matchBranch && matchStatus;
                }).map(chat => {
                  const isActive = chat.record.id === activeChatRecordId;
                  const lastMsg = chat.last_message;
                  const initials = chat.record.student_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
                  const lastMsgTime = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
                  
                  const tagVal = chat.record.pipeline_tag || 'Lead';
                  const showTag = true;
                  const tagBadge = `badge-tag-${tagVal.toLowerCase().replace(' ', '-')}`;
                  const tagText = tagVal;

                  return (
                    <div 
                      key={chat.record.id} 
                      className={`conversation-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setActiveChatRecordId(chat.record.id);
                        fetchChatHistory(chat.record.id);
                        fetchChatNotes(chat.record.id);
                        setActiveChatSubTab('chat');
                        setMobileActiveSubView('thread');
                        setSelectedChatTemplate('');
                        setForceFreeForm(false);
                      }}
                    >
                      <div className="avatar-circle">{initials}</div>
                      <div className="conv-details">
                        <div className="conv-name-row" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'space-between', width: '100%' }}>
                          <span className="conv-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            {chat.record.student_name}
                            {chat.record.unresolved_notes_count > 0 && (
                              <span title={`${chat.record.unresolved_notes_count} pending notes`} style={{ fontSize: '0.85rem' }}>📝</span>
                            )}
                          </span>
                          {showTag && (
                            <span className={`badge ${tagBadge}`} style={{ fontSize: '0.65rem', padding: '0.15rem 0.35rem', fontWeight: '600' }}>{tagText}</span>
                          )}
                          <span className="conv-time" style={{ whiteSpace: 'nowrap' }}>{lastMsgTime}</span>
                        </div>
                        <div className="conv-preview-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '0.4rem', marginTop: '2px' }}>
                          <p className="conv-msg-preview" style={{ flexGrow: 1, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {lastMsg ? lastMsg.message_text : 'No messages yet'}
                          </p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                            {chat.record.unread_count > 0 && (
                              <span style={{
                                backgroundColor: 'var(--color-blue)',
                                color: '#fff',
                                borderRadius: '50%',
                                minWidth: '18px',
                                height: '18px',
                                fontSize: '0.7rem',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 'bold',
                                padding: '0 4px',
                                boxShadow: '0 1px 3px rgba(37, 99, 235, 0.3)'
                              }}>
                                {chat.record.unread_count}
                              </span>
                            )}
                            {lastMsg && lastMsg.sender === 'parent' && (
                              <span style={{
                                width: '8px',
                                height: '8px',
                                backgroundColor: 'var(--color-blue)',
                                borderRadius: '50%',
                                display: 'inline-block',
                                boxShadow: '0 0 4px rgba(37, 99, 235, 0.5)'
                              }}></span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {chatsList.length === 0 && (
                  <div className="chat-empty-state">
                    <p>No active conversations yet.</p>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Active Chat History Thread Pane */}
            <div className="glass-panel chat-window-panel">
              {activeChatRecordId && (currentUser?.role !== 'counselor' || chatsList.some(c => c.record.id === activeChatRecordId)) ? (
                <>
                  <div className="chat-header" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button 
                      className="btn btn-secondary btn-sm mobile-only-flex" 
                      onClick={() => setMobileActiveSubView('list')}
                      style={{ padding: '0.4rem 0.6rem' }}
                    >
                      ← Back
                    </button>
                    <div className="chat-header-title" style={{ flexGrow: 1 }}>
                      {(() => {
                        const activeRecord = currentUser?.role === 'counselor' 
                          ? chatsList.find(c => c.record.id === activeChatRecordId)?.record
                          : (chatsList.find(c => c.record.id === activeChatRecordId)?.record 
                              || contactsList.find(c => c.id === activeChatRecordId)
                              || records.find(r => r.id === activeChatRecordId));
                        return (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <div>
                              <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                                <span>🎓 {activeRecord ? activeRecord.student_name : 'Loading...'}</span>
                                {activeRecord?.parent_name && activeRecord.parent_name !== 'N/A' && activeRecord.parent_name !== 'None' && activeRecord.parent_name !== 'Unknown Parent' && (
                                  <span style={{ fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-secondary)' }}>
                                    (Parent: 👨‍👩‍👧 {activeRecord.parent_name})
                                  </span>
                                )}
                                {activeRecord?.selected_branch && (
                                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#475569', background: '#f1f5f9', padding: '2px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                                    🏫 Branch: {activeRecord.selected_branch}
                                  </span>
                                )}
                              </h4>
                              {activeRecord && (
                                <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8rem', marginTop: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                  <span 
                                    onClick={() => {
                                      setChatThreadFilter('student');
                                      setChatRecipient('student');
                                    }}
                                    style={{ 
                                      padding: '0.15rem 0.5rem', 
                                      borderRadius: '4px', 
                                      backgroundColor: chatRecipient === 'student' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(0, 0, 0, 0.04)',
                                      border: chatRecipient === 'student' ? '1px solid var(--color-blue-border)' : '1px solid transparent',
                                      color: chatRecipient === 'student' ? 'var(--color-blue)' : 'var(--text-secondary)',
                                      fontWeight: chatRecipient === 'student' ? '700' : '500',
                                      cursor: 'pointer',
                                      userSelect: 'none'
                                    }}
                                    title="Click to switch to Student Chat"
                                  >
                                    📱 Student: <strong>+{activeRecord.phone_number}</strong>
                                  </span>

                                  <span 
                                    onClick={() => {
                                      if (activeRecord.parent_phone_number) {
                                        setChatThreadFilter('parent');
                                        setChatRecipient('parent');
                                      }
                                    }}
                                    style={{ 
                                      padding: '0.15rem 0.5rem', 
                                      borderRadius: '4px', 
                                      backgroundColor: chatRecipient === 'parent' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(0, 0, 0, 0.04)',
                                      border: chatRecipient === 'parent' ? '1px solid var(--color-blue-border)' : '1px solid transparent',
                                      color: chatRecipient === 'parent' ? 'var(--color-blue)' : 'var(--text-secondary)',
                                      fontWeight: chatRecipient === 'parent' ? '700' : '500',
                                      cursor: activeRecord.parent_phone_number ? 'pointer' : 'not-allowed',
                                      userSelect: 'none'
                                    }}
                                    title={activeRecord.parent_phone_number ? "Click to switch to Parent Chat" : "Parent number not registered"}
                                  >
                                    📱 Parent: {activeRecord.parent_phone_number ? <strong>+{activeRecord.parent_phone_number}</strong> : <em style={{ opacity: 0.6 }}>Not Registered</em>}
                                  </span>
                                </div>
                              )}
                            </div>
                            {activeRecord && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <span 
                                  className={`badge-tag-${(activeRecord.pipeline_tag || 'Lead').toLowerCase().replace(' ', '-')}`}
                                  style={{ 
                                    padding: '0.35rem 0.75rem', 
                                    borderRadius: '6px', 
                                    fontSize: '0.75rem', 
                                    fontWeight: '700',
                                    display: 'inline-block',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                  }}
                                >
                                  {activeRecord.pipeline_tag || 'Lead'}
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)' }}>Stage:</span>
                                  <select
                                    value={activeRecord.pipeline_tag || 'Lead'}
                                    onChange={(e) => handleUpdateTag(activeRecord.id, e.target.value)}
                                    style={{
                                      padding: '0.3rem 0.6rem',
                                      borderRadius: '6px',
                                      fontSize: '0.75rem',
                                      fontWeight: '600',
                                      border: '1px solid var(--border-color)',
                                      backgroundColor: '#ffffff',
                                      cursor: 'pointer',
                                      outline: 'none',
                                      color: 'var(--color-text)',
                                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                                    }}
                                  >
                                    <option value="Lead">Lead</option>
                                    <option value="Contacted">Contacted</option>
                                    <option value="Interested">Interested</option>
                                    <option value="Not Interested">Not Interested</option>
                                    <option value="Enrolled">Enrolled</option>
                                  </select>
                                </div>

                                {/* Counselor Work Status Dropdown (Pending vs Completed) */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)' }}>Status:</span>
                                  <select
                                    value={activeRecord.counselor_status || 'active'}
                                    onChange={(e) => updateCounselorStatus(activeRecord.id, e.target.value)}
                                    style={{
                                      padding: '0.3rem 0.65rem',
                                      borderRadius: '6px',
                                      fontSize: '0.75rem',
                                      fontWeight: '700',
                                      border: (activeRecord.counselor_status || 'active') === 'completed' ? '1px solid #10b981' : '1px solid #ef4444',
                                      backgroundColor: (activeRecord.counselor_status || 'active') === 'completed' ? '#ecfdf5' : '#fef2f2',
                                      color: (activeRecord.counselor_status || 'active') === 'completed' ? '#047857' : '#dc2626',
                                      cursor: 'pointer',
                                      outline: 'none',
                                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                                    }}
                                  >
                                    <option value="active">🔴 Pending (In Progress)</option>
                                    <option value="completed">🟢 Completed (Resolved)</option>
                                  </select>
                                </div>

                                {/* Counselor Lead Assignment Control (Super Admin Only) */}
                                {currentUser?.role === 'super_admin' && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)' }}>Counselor:</span>
                                    <select
                                      value={activeRecord.assigned_counselor_id || ''}
                                      onChange={(e) => {
                                        const selectedId = e.target.value ? parseInt(e.target.value) : null;
                                        const selectedUser = teamUsers.find(u => u.id === selectedId);
                                        handleAssignLead(activeRecord.id, selectedId, selectedUser ? (selectedUser.full_name || selectedUser.username) : null);
                                      }}
                                      style={{
                                        padding: '0.3rem 0.6rem',
                                        borderRadius: '6px',
                                        fontSize: '0.75rem',
                                        fontWeight: '600',
                                        border: '1px solid #cbd5e1',
                                        backgroundColor: activeRecord.assigned_counselor_id ? '#f0fdf4' : '#ffffff',
                                        color: activeRecord.assigned_counselor_id ? '#166534' : '#64748b',
                                        cursor: 'pointer',
                                        outline: 'none',
                                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                                      }}
                                    >
                                      <option value="">-- Unassigned --</option>
                                      {(teamUsers.some(u => u.role === 'counselor') 
                                        ? teamUsers.filter(u => u.role === 'counselor') 
                                        : teamUsers
                                      ).map(u => (
                                        <option key={u.id} value={u.id}>
                                          {u.full_name || u.username} ({u.role === 'super_admin' ? 'Admin' : 'Counselor'})
                                        </option>
                                      ))}
                                    </select>

                                    <button
                                      type="button"
                                      onClick={() => handleAutoAssignLead(activeRecord.id)}
                                      className="btn btn-sm"
                                      style={{
                                        backgroundColor: '#2563eb',
                                        color: '#ffffff',
                                        fontSize: '0.75rem',
                                        fontWeight: '700',
                                        padding: '0.3rem 0.6rem',
                                        borderRadius: '6px',
                                        border: 'none',
                                        cursor: 'pointer',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        boxShadow: '0 1px 2px rgba(37, 99, 235, 0.3)'
                                      }}
                                      title="Automatically assign to counselor with lowest workload (Round-Robin)"
                                    >
                                      ⚡ Auto-Assign
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  
                  <div className="chat-window-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', backgroundColor: '#f8fafc' }}>
                    <button 
                      onClick={() => setActiveChatSubTab('chat')}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: '600',
                        color: activeChatSubTab === 'chat' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                        border: 'none',
                        borderBottom: activeChatSubTab === 'chat' ? '2px solid var(--color-blue)' : '2px solid transparent',
                        background: 'transparent',
                        outline: 'none',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                    >
                      💬 Chat History
                    </button>
                    <button 
                      onClick={() => setActiveChatSubTab('notes')}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: '600',
                        color: activeChatSubTab === 'notes' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                        border: 'none',
                        borderBottom: activeChatSubTab === 'notes' ? '2px solid var(--color-blue)' : '2px solid transparent',
                        background: 'transparent',
                        outline: 'none',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                    >
                      📝 Counselor Notes {chatNotes.filter(n => !n.resolved).length > 0 ? `(${chatNotes.filter(n => !n.resolved).length})` : ''}
                    </button>
                  </div>

                  {activeChatSubTab === 'chat' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 1rem', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '0.78rem' }}>
                        <span style={{ fontWeight: 600, color: '#64748b' }}>Active Chat Thread:</span>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            type="button"
                            onClick={() => {
                              setChatThreadFilter('parent');
                              setChatRecipient('parent');
                            }}
                            style={{
                              padding: '0.3rem 0.8rem',
                              borderRadius: '14px',
                              fontSize: '0.76rem',
                              fontWeight: 600,
                              border: 'none',
                              outline: 'none',
                              cursor: 'pointer',
                              background: chatThreadFilter === 'parent' ? '#2563eb' : '#e2e8f0',
                              color: chatThreadFilter === 'parent' ? '#ffffff' : '#475569',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            👨‍👩‍👦 Parent Chat
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setChatThreadFilter('student');
                              setChatRecipient('student');
                            }}
                            style={{
                              padding: '0.3rem 0.8rem',
                              borderRadius: '14px',
                              fontSize: '0.76rem',
                              fontWeight: 600,
                              border: 'none',
                              outline: 'none',
                              cursor: 'pointer',
                              background: chatThreadFilter === 'student' ? '#2563eb' : '#e2e8f0',
                              color: chatThreadFilter === 'student' ? '#ffffff' : '#475569',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            🎓 Student Chat
                          </button>
                        </div>
                      </div>

                      <div className="chat-messages-area" ref={chatContainerRef}>
                        {chatHistory
                          .filter(msg => {
                            if (chatThreadFilter === 'parent') {
                              return msg.sender === 'parent' || msg.recipient_type === 'parent';
                            }
                            if (chatThreadFilter === 'student') {
                              return msg.sender === 'student' || msg.recipient_type === 'student';
                            }
                            return true;
                          })
                          .map((msg, index) => {
                          const bubbleClass = (msg.sender === 'parent' || msg.sender === 'student') ? 'parent' : msg.sender === 'counselor' ? 'counselor' : 'system';
                          let senderLabel = '';
                          if (msg.sender === 'parent') {
                            senderLabel = 'Parent';
                          } else if (msg.sender === 'student') {
                            senderLabel = 'Student';
                          } else if (msg.sender === 'counselor') {
                            senderLabel = msg.recipient_type === 'student' ? 'Counselor to Student' : 'Counselor to Parent';
                          } else {
                            senderLabel = msg.recipient_type === 'student' ? 'Bot to Student' : 'Bot to Parent';
                          }
                          const msgTime = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                          
                          // Determine WhatsApp-style status checkmark SVG
                          let statusTick = null;
                          if (msg.sender !== 'parent' && msg.sender !== 'student') {
                            const status = (msg.delivery_status || 'sent').toLowerCase();
                            if (status === 'read') {
                              statusTick = (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#53bdeb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginLeft: '4px', display: 'inline-block' }} title="Read">
                                  <path d="M17 6L8.5 14.5L5 11M22 6L13.5 14.5" />
                                </svg>
                              );
                            } else if (status === 'delivered') {
                              statusTick = (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginLeft: '4px', display: 'inline-block' }} title="Delivered">
                                  <path d="M17 6L8.5 14.5L5 11M22 6L13.5 14.5" />
                                </svg>
                              );
                            } else if (status === 'failed') {
                              statusTick = (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ea0038" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginLeft: '4px', display: 'inline-block' }} title="Failed to send">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="12" y1="8" x2="12" y2="12" />
                                  <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                              );
                            } else {
                              statusTick = (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginLeft: '4px', display: 'inline-block' }} title="Sent">
                                  <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                              );
                            }
                          }

                          return (
                            <div key={msg.id || index} className={`message-bubble-row ${bubbleClass}`}>
                              <div className="message-bubble">{msg.message_text}</div>
                              <div className="message-meta-info">
                                <span>{senderLabel}</span> • <span>{msgTime}</span>
                                {statusTick}
                              </div>
                            </div>
                          );
                        })}
                        {chatHistory.length === 0 && (
                          <div className="chat-empty-state">
                            <p>No messages in this chat yet.</p>
                          </div>
                        )}
                        {/* Sentinel element — always at the bottom so we can scroll to it */}
                        <div ref={chatBottomRef} style={{ height: 0 }} />
                      </div>
                      <div className="chat-input-area" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '1rem', borderTop: '1px solid var(--border-color)', backgroundColor: '#ffffff' }}>
                        {!chatSession.active ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-amber)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="8" x2="12" y2="12"></line>
                                <line x1="12" y1="16" x2="12.01" y2="16"></line>
                              </svg>
                              <span>WhatsApp 24h service session is inactive. Send a template message to resume:</span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                              <select 
                                value={selectedChatTemplate} 
                                onChange={(e) => setSelectedChatTemplate(e.target.value)} 
                                className="filter-select"
                                style={{ flexGrow: 1, padding: '0.5rem', fontSize: '0.85rem', height: '38px', backgroundPosition: 'right 0.65rem center' }}
                              >
                                <option value="">-- Select Template --</option>
                                {templatesList.map(t => (
                                  <option key={t.id} value={t.template_name}>{t.template_name}</option>
                                ))}
                              </select>
                              <button 
                                className="btn btn-primary"
                                onClick={sendManualTemplateMessage}
                                disabled={sendingChat || !selectedChatTemplate}
                                style={{ backgroundColor: 'var(--color-amber)', borderColor: 'var(--color-amber)', height: '38px', padding: '0 1rem', fontSize: '0.8rem' }}
                              >
                                {sendingChat ? 'Sending...' : 'Send Template'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
                            {/* Status Line */}
                            <div style={{ fontSize: '0.72rem', color: 'var(--color-emerald)', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, paddingLeft: '2px' }}>
                              <span style={{ width: '6px', height: '6px', backgroundColor: 'var(--color-emerald)', borderRadius: '50%', display: 'inline-block' }}></span>
                              <span>WhatsApp Session Active (Expires in {formatSecondsToHMS(secondsLeft)})</span>
                            </div>

                            {/* Optional Template Quick Sender */}
                            <div style={{ display: 'flex', gap: '8px', width: '100%', alignItems: 'center', borderBottom: '1px dashed #e2e8f0', paddingBottom: '8px' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>Or Send Template:</span>
                              <select 
                                value={selectedChatTemplate} 
                                onChange={(e) => setSelectedChatTemplate(e.target.value)} 
                                className="filter-select"
                                style={{ flexGrow: 1, padding: '0.25rem 0.5rem', fontSize: '0.85rem', height: '32px', backgroundPosition: 'right 0.65rem center' }}
                              >
                                <option value="">-- Select Template --</option>
                                {templatesList.map(t => (
                                  <option key={t.id} value={t.template_name}>{t.template_name}</option>
                                ))}
                              </select>
                              <button 
                                className="btn btn-secondary"
                                onClick={sendManualTemplateMessage}
                                disabled={sendingChat || !selectedChatTemplate}
                                style={{ height: '32px', padding: '0 0.75rem', fontSize: '0.75rem' }}
                              >
                                Send Template
                              </button>
                            </div>

                            {/* Free-form Input Text Box */}
                            <div style={{ display: 'flex', gap: '8px', width: '100%', alignItems: 'center' }}>
                              <textarea 
                                placeholder="Type your response here..." 
                                className="chat-input-box"
                                value={typedMessage}
                                onChange={(e) => setTypedMessage(e.target.value)}
                                style={{ flexGrow: 1, height: '44px', margin: 0 }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    sendManualMessage();
                                  }
                                }}
                              />
                              <button 
                                className="btn btn-primary"
                                onClick={sendManualMessage}
                                disabled={sendingChat || !typedMessage.trim()}
                                style={{ height: '44px', padding: '0 1.25rem' }}
                              >
                                {sendingChat ? 'Sending...' : 'Send'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="chat-messages-area" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.25rem', height: 'calc(100% - 100px)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flexGrow: 1, overflowY: 'auto', paddingRight: '0.25rem' }}>
                        {chatNotes.map((note) => {
                          const noteTime = new Date(note.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                          const isResolved = note.resolved;
                          return (
                            <div key={note.id} style={{
                              backgroundColor: isResolved ? 'var(--color-grey-light)' : '#fffbeb',
                              border: isResolved ? '1px solid var(--color-grey-border)' : '1px solid var(--color-amber-border)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.85rem 1rem',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                              textAlign: 'left',
                              opacity: isResolved ? 0.75 : 1
                            }}>
                              <p style={{ 
                                fontSize: '0.875rem', 
                                color: isResolved ? 'var(--color-grey)' : '#1e293b', 
                                lineHeight: '1.4', 
                                whiteSpace: 'pre-wrap', 
                                margin: 0,
                                textDecoration: isResolved ? 'line-through' : 'none'
                              }}>
                                {note.note_text}
                              </p>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: isResolved ? 'var(--color-grey)' : 'var(--color-amber)', marginTop: '0.5rem', fontWeight: '500' }}>
                                <span>By: {note.created_by} • {noteTime}</span>
                                {isResolved ? (
                                  <span style={{ color: 'var(--color-emerald)', fontWeight: 'bold' }}>✓ Resolved</span>
                                ) : (
                                  <button
                                    onClick={() => resolveChatNote(note.id)}
                                    style={{
                                      backgroundColor: 'var(--color-emerald)',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: 'var(--radius-sm)',
                                      padding: '0.2rem 0.5rem',
                                      fontSize: '0.65rem',
                                      cursor: 'pointer',
                                      fontWeight: '600'
                                    }}
                                  >
                                    Resolve
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {chatNotes.length === 0 && (
                          <div className="chat-empty-state" style={{ padding: '2rem' }}>
                            <p>No internal notes recorded for this candidate yet.</p>
                          </div>
                        )}
                      </div>
                      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <textarea 
                          placeholder="Type internal counselor notes here... (e.g. details from call, parent responses, etc.)"
                          value={newNoteText}
                          onChange={(e) => setNewNoteText(e.target.value)}
                          style={{
                            width: '100%',
                            minHeight: '80px',
                            padding: '0.75rem',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            fontSize: '0.875rem',
                            resize: 'vertical',
                            fontFamily: 'inherit'
                          }}
                        />
                        <button 
                          onClick={addChatNote}
                          disabled={addingNote || !newNoteText.trim()}
                          className="btn btn-primary"
                          style={{ alignSelf: 'flex-end', padding: '0.5rem 1.25rem' }}
                        >
                          {addingNote ? 'Saving...' : 'Save Note'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="chat-empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '2.5rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '3rem', marginBottom: '0.85rem' }}>✨</div>
                  <h4 style={{ margin: '0 0 0.5rem 0', fontWeight: 700, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    {currentUser?.role === 'counselor' ? 'All Caught Up!' : 'Select a Conversation'}
                  </h4>
                  <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)', maxWidth: '360px', lineHeight: '1.5' }}>
                    {currentUser?.role === 'counselor' 
                      ? 'No active candidate chats assigned to your account yet. When admin assigns students to you, they will appear here automatically.'
                      : 'Click a student from the active list to view chat history and reply.'}
                  </p>
                  {currentUser?.role === 'counselor' && (
                    <span style={{ marginTop: '1.25rem', padding: '0.4rem 0.85rem', background: '#f0fdf4', color: '#166534', borderRadius: '20px', fontSize: '0.78rem', fontWeight: '600', border: '1px solid #bbf7d0' }}>
                      🟢 Counselor Inbox Status: Online & Ready
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* 3. Counselor Workload & Dynamic Distribution Panel (Super Admin Only) */}
            {currentUser?.role === 'super_admin' && (
              <div className="glass-panel rules-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '1.25rem' }}>
                <div className="panel-header" style={{ paddingBottom: '0.85rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <button 
                    className="btn btn-secondary btn-sm mobile-only-flex" 
                    onClick={() => setMobileActiveSubView('list')}
                    style={{ padding: '0.4rem 0.6rem' }}
                  >
                    ← Back
                  </button>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--color-heading)' }}>
                      👥 Counselor Management
                    </h4>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      Distribute student leads & balance counselor workload.
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
                  {(() => {
                    const activeRecord = chatsList.find(c => c.record.id === activeChatRecordId)?.record 
                      || contactsList.find(c => c.id === activeChatRecordId)
                      || records.find(r => r.id === activeChatRecordId);
                    return activeRecord ? (
                      <div style={{
                        padding: '1rem',
                        borderRadius: '8px',
                        backgroundColor: '#f8fafc',
                        border: '1px solid #e2e8f0',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.75rem'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <span style={{ fontSize: '0.7rem', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            CURRENT LEAD ASSIGNMENT
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                            <div style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: activeRecord.assigned_counselor_name ? '#dcfce7' : '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', color: activeRecord.assigned_counselor_name ? '#15803d' : '#64748b', fontWeight: '700' }}>
                              👤
                            </div>
                            <span style={{ fontWeight: '700', fontSize: '0.9rem', color: '#0f172a' }}>
                              {activeRecord.assigned_counselor_name || 'Unassigned'}
                            </span>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#475569' }}>Change Counselor:</label>
                          <select
                            value={activeRecord.assigned_counselor_id || ''}
                            onChange={(e) => {
                              const selectedId = e.target.value ? parseInt(e.target.value) : null;
                              const selectedUser = teamUsers.find(u => u.id === selectedId);
                              handleAssignLead(activeRecord.id, selectedId, selectedUser ? (selectedUser.full_name || selectedUser.username) : null);
                            }}
                            style={{
                              padding: '0.45rem 0.75rem',
                              borderRadius: '6px',
                              fontSize: '0.82rem',
                              border: '1px solid #cbd5e1',
                              backgroundColor: '#ffffff',
                              color: '#0f172a',
                              cursor: 'pointer'
                            }}
                          >
                            <option value="">-- Unassigned --</option>
                            {(teamUsers.some(u => u.role === 'counselor') 
                              ? teamUsers.filter(u => u.role === 'counselor') 
                              : teamUsers
                            ).map(u => (
                              <option key={u.id} value={u.id}>
                                {u.full_name || u.username} ({u.role === 'super_admin' ? 'Admin' : 'Counselor'})
                              </option>
                            ))}
                          </select>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleAutoAssignLead(activeRecord.id)}
                          className="btn btn-primary btn-sm"
                          style={{
                            width: '100%',
                            justifyContent: 'center',
                            padding: '0.5rem',
                            fontSize: '0.82rem',
                            fontWeight: '700',
                            backgroundColor: '#2563eb',
                            color: '#ffffff',
                            borderRadius: '6px',
                            border: 'none',
                            cursor: 'pointer',
                            marginTop: '0.25rem'
                          }}
                        >
                          ⚡ Auto-Assign (Round-Robin)
                        </button>
                      </div>
                    ) : null;
                  })()}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#334155' }}>
                        Active Counselor Workload
                      </span>
                      <button
                        type="button"
                        onClick={fetchWorkloadStats}
                        style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.75rem', cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                      >
                        🔄 Refresh
                      </button>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {(workloadStats.some(w => w.counselor.role === 'counselor') 
                        ? workloadStats.filter(w => w.counselor.role === 'counselor') 
                        : workloadStats
                      ).map((item) => (
                        <div key={item.counselor.id} style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '6px',
                          backgroundColor: '#f8fafc',
                          border: '1px solid #e2e8f0',
                          fontSize: '0.82rem'
                        }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontWeight: '700', color: '#1e293b' }}>{item.counselor.full_name || item.counselor.username}</span>
                            <span style={{ fontSize: '0.7rem', color: '#64748b' }}>{item.counselor.role === 'super_admin' ? 'Super Admin' : 'Counselor'}</span>
                          </div>
                          <span style={{
                            padding: '0.2rem 0.6rem',
                            borderRadius: '12px',
                            backgroundColor: item.assigned_lead_count > 0 ? '#e0f2fe' : '#f1f5f9',
                            color: item.assigned_lead_count > 0 ? '#0369a1' : '#64748b',
                            fontWeight: '700',
                            fontSize: '0.75rem'
                          }}>
                            {item.assigned_lead_count} {item.assigned_lead_count === 1 ? 'lead' : 'leads'}
                          </span>
                        </div>
                      ))}

                      {workloadStats.length === 0 && (
                        <p style={{ fontSize: '0.8rem', color: '#94a3b8', textAlign: 'center', margin: 0 }}>
                          No active counselor accounts registered yet.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

        {activeView === 'bot-builder' && (
          <div style={{ height: '100%', width: '100%' }}>
            <FlowBuilder authFetch={authFetch} API_BASE={API_BASE} activeView={activeView} templatesList={templatesList} />
          </div>
        )}

        {activeView === 'brochures' && (
          <div className="glass-panel" style={{ padding: '1.75rem', borderRadius: 'var(--radius-lg)', marginBottom: '4rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '1.3rem' }}>
                  <span>📚</span> AI Website & Brochure Knowledge Base
                </h3>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.88rem', margin: '0.35rem 0 0 0' }}>
                  Crawl any college website URL or upload PDF brochures. The AI Chatbot indexes all pages and documents to answer student and parent WhatsApp inquiries automatically.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  onClick={() => { fetchBrochures(); fetchWebsitePages(); }}
                  className="btn btn-secondary btn-sm"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                  Refresh All Data
                </button>
              </div>
            </div>

            {/* 1. Website Crawler Card */}
            <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1.25rem', marginBottom: '1.75rem' }}>
              <h5 style={{ margin: '0 0 0.85rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', color: '#1e293b' }}>
                <span>🌐</span> Crawl & Auto-Index College Website URL
              </h5>
              <form onSubmit={handleCrawlWebsite} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', alignItems: 'end' }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>College / University Target URL</label>
                  <input 
                    type="url" 
                    placeholder="https://your-college-website.edu.in/"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    className="filter-select"
                    style={{ width: '100%' }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Max Pages to Index</label>
                  <select 
                    value={maxPagesToCrawl} 
                    onChange={(e) => setMaxPagesToCrawl(e.target.value)}
                    className="filter-select"
                    style={{ width: '100%' }}
                  >
                    <option value="1">1 Page (Only This Specific URL - Instant)</option>
                    <option value="5">5 Internal Pages (Fast)</option>
                    <option value="10">10 Internal Pages</option>
                    <option value="25">25 Internal Pages</option>
                    <option value="50">50 Internal Pages</option>
                    <option value="100">100 Internal Pages</option>
                  </select>
                </div>
                <div>
                  <button 
                    type="submit" 
                    className="btn btn-primary"
                    disabled={crawlingWebsite || !websiteUrl.trim()}
                    style={{ width: '100%', height: '38px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', background: '#2563eb' }}
                  >
                    {crawlingWebsite ? "Crawling Website Pages..." : "Crawl & Index Website"}
                  </button>
                </div>
              </form>
            </div>

            {/* Indexed Website Pages Table */}
            {websitePages.length > 0 && (
              <div style={{ marginBottom: '2.5rem' }}>
                <h5 style={{ marginBottom: '0.75rem', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>🔗</span> Indexed Website Pages ({websitePages.length})
                </h5>
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Page Title</th>
                        <th>URL</th>
                        <th>Content Preview</th>
                        <th>AI Status</th>
                        <th>Crawled Date</th>
                        <th className="text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {websitePages.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--color-text-main)' }}>{p.title}</div>
                          </td>
                          <td>
                            <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8rem', color: '#2563eb', textDecoration: 'underline' }}>
                              {p.url.length > 35 ? p.url.substring(0, 35) + '...' : p.url}
                            </a>
                          </td>
                          <td style={{ maxWidth: '280px' }}>
                            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {p.text_preview}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => handleToggleWebsitePage(p.id)}
                              style={{
                                border: 'none',
                                background: p.is_active ? '#dcfce7' : '#f1f5f9',
                                color: p.is_active ? '#15803d' : '#64748b',
                                padding: '4px 10px',
                                borderRadius: '12px',
                                fontWeight: 700,
                                fontSize: '0.75rem',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px'
                              }}
                            >
                              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: p.is_active ? '#22c55e' : '#94a3b8' }}></span>
                              {p.is_active ? 'Active AI Knowledge' : 'Disabled'}
                            </button>
                          </td>
                          <td>
                            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                              {p.crawled_at ? new Date(p.crawled_at).toLocaleDateString() : 'N/A'}
                            </span>
                          </td>
                          <td className="text-right">
                            <div className="table-actions" style={{ justifyContent: 'flex-end', gap: '6px' }}>
                              <button
                                onClick={() => setSelectedPreviewPage(p)}
                                className="btn btn-secondary btn-sm"
                                title="View full page text"
                              >
                                Preview
                              </button>
                              <button
                                onClick={() => handleDeleteWebsitePage(p.id)}
                                className="btn btn-danger btn-sm"
                                title="Delete page"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 2. Upload Brochure Document Card */}
            <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1.25rem', marginBottom: '1.75rem' }}>
              <h5 style={{ margin: '0 0 0.85rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', color: '#1e293b' }}>
                <span>📤</span> Upload PDF / TXT Brochure File
              </h5>
              <form onSubmit={handleUploadBrochure} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', alignItems: 'end' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Document Title / Subject</label>
                  <input 
                    type="text" 
                    placeholder="e.g. 2026 Fee Structure & Hostel Manual"
                    value={brochureTitle}
                    onChange={(e) => setBrochureTitle(e.target.value)}
                    className="filter-select"
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Select PDF or TXT File</label>
                  <input 
                    type="file"
                    accept=".pdf,.txt,.md"
                    onChange={(e) => setSelectedBrochureFile(e.target.files[0] || null)}
                    className="filter-select"
                    style={{ width: '100%', padding: '4px 8px' }}
                  />
                </div>
                <div>
                  <button 
                    type="submit" 
                    className="btn btn-primary"
                    disabled={uploadingBrochure || !selectedBrochureFile}
                    style={{ width: '100%', height: '38px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                  >
                    {uploadingBrochure ? "Extracting & Indexing..." : "Upload & Index Brochure"}
                  </button>
                </div>
              </form>
            </div>

            {/* Documents List */}
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Document Title</th>
                    <th>Filename</th>
                    <th>Extracted Knowledge Preview</th>
                    <th>AI Status</th>
                    <th>Uploaded Date</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {brochures.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
                        <div style={{ fontSize: '2rem', marginBottom: '0.4rem' }}>📄</div>
                        <p style={{ fontWeight: 600, color: 'var(--color-text-muted)', margin: 0 }}>No PDF brochures uploaded yet.</p>
                      </td>
                    </tr>
                  ) : (
                    brochures.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--color-text-main)' }}>{b.title}</div>
                        </td>
                        <td>
                          <span style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>{b.filename}</span>
                        </td>
                        <td style={{ maxWidth: '280px' }}>
                          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {b.text_preview}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => handleToggleBrochure(b.id)}
                            style={{
                              border: 'none',
                              background: b.is_active ? '#dcfce7' : '#f1f5f9',
                              color: b.is_active ? '#15803d' : '#64748b',
                              padding: '4px 10px',
                              borderRadius: '12px',
                              fontWeight: 700,
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px'
                            }}
                          >
                            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: b.is_active ? '#22c55e' : '#94a3b8' }}></span>
                            {b.is_active ? 'Active AI Knowledge' : 'Disabled'}
                          </button>
                        </td>
                        <td>
                          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                            {b.uploaded_at ? new Date(b.uploaded_at).toLocaleDateString() : 'N/A'}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="table-actions" style={{ justifyContent: 'flex-end', gap: '6px' }}>
                            <button
                              onClick={() => setSelectedPreviewBrochure(b)}
                              className="btn btn-secondary btn-sm"
                              title="View full extracted text"
                            >
                              Preview
                            </button>
                            <button
                              onClick={() => handleDeleteBrochure(b.id)}
                              className="btn btn-danger btn-sm"
                              title="Delete brochure"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Extracted Text Preview Modal (Brochure) */}
            {selectedPreviewBrochure && (
              <div className="modal-backdrop" onClick={() => setSelectedPreviewBrochure(null)}>
                <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '650px', width: '90%' }}>
                  <div className="modal-header">
                    <h4>📖 Brochure Text: {selectedPreviewBrochure.title}</h4>
                    <button className="modal-close" onClick={() => setSelectedPreviewBrochure(null)}>×</button>
                  </div>
                  <div className="modal-body" style={{ maxHeight: '450px', overflowY: 'auto' }}>
                    <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '6px', fontSize: '0.85rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#334155', border: '1px solid #e2e8f0' }}>
                      {selectedPreviewBrochure.extracted_text}
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={() => setSelectedPreviewBrochure(null)}>Close Preview</button>
                  </div>
                </div>
              </div>
            )}

            {/* Extracted Text Preview Modal (Website Page) */}
            {selectedPreviewPage && (
              <div className="modal-backdrop" onClick={() => setSelectedPreviewPage(null)}>
                <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '650px', width: '90%' }}>
                  <div className="modal-header">
                    <h4>🌐 Web Page Content: {selectedPreviewPage.title}</h4>
                    <button className="modal-close" onClick={() => setSelectedPreviewPage(null)}>×</button>
                  </div>
                  <div className="modal-body" style={{ maxHeight: '450px', overflowY: 'auto' }}>
                    <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem', color: '#2563eb' }}>
                      <strong>URL:</strong> <a href={selectedPreviewPage.url} target="_blank" rel="noopener noreferrer">{selectedPreviewPage.url}</a>
                    </div>
                    <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '6px', fontSize: '0.85rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#334155', border: '1px solid #e2e8f0' }}>
                      {selectedPreviewPage.extracted_text}
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={() => setSelectedPreviewPage(null)}>Close Preview</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeView === 'team' && (
          <div className="glass-panel" style={{ padding: '1.75rem', borderRadius: 'var(--radius-lg)', marginBottom: '8rem', paddingBottom: '4rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '1.3rem' }}>
                  <span>👥</span> Team & Staff Management
                </h3>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.88rem', margin: '0.35rem 0 0 0' }}>
                  Create and manage counselor and administrator accounts with email-based authentication and role-based permissions.
                </p>
              </div>
            </div>

            {/* Metric Summary Bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#dbeafe', color: '#1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 'bold' }}>👥</div>
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>TOTAL STAFF</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1e293b' }}>{teamUsers.length}</div>
                </div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#dcfce7', color: '#15803d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 'bold' }}>💬</div>
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>COUNSELORS</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1e293b' }}>{teamUsers.filter(u => u.role === 'counselor').length}</div>
                </div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#fef3c7', color: '#b45309', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 'bold' }}>👑</div>
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>SUPER ADMINS</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1e293b' }}>{teamUsers.filter(u => u.role === 'super_admin').length}</div>
                </div>
              </div>
            </div>

            {/* Create New Staff Account Form */}
            <div style={{ background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 'var(--radius-md)', padding: '1.25rem', marginBottom: '1.75rem' }}>
              <h5 style={{ margin: '0 0 0.85rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', color: '#1e293b' }}>
                <span>➕</span> Add New Staff / Counselor Account
              </h5>
              <form onSubmit={handleCreateStaffUser} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', alignItems: 'end' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Full Name</label>
                  <input 
                    type="text" 
                    placeholder="Enter full name"
                    value={newStaffFullName}
                    onChange={(e) => setNewStaffFullName(e.target.value)}
                    className="form-input"
                    style={{ width: '100%' }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Work Email</label>
                  <input 
                    type="email" 
                    placeholder="Enter work email"
                    value={newStaffEmail}
                    onChange={(e) => setNewStaffEmail(e.target.value)}
                    className="form-input"
                    style={{ width: '100%' }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Username</label>
                  <input 
                    type="text" 
                    placeholder="Enter username"
                    value={newStaffUsername}
                    onChange={(e) => setNewStaffUsername(e.target.value)}
                    className="form-input"
                    style={{ width: '100%' }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Initial Password</label>
                  <input 
                    type="password" 
                    placeholder="Enter password"
                    value={newStaffPassword}
                    onChange={(e) => setNewStaffPassword(e.target.value)}
                    className="form-input"
                    style={{ width: '100%' }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Role</label>
                  <select 
                    value={newStaffRole} 
                    onChange={(e) => setNewStaffRole(e.target.value)}
                    className="filter-select"
                    style={{ width: '100%' }}
                  >
                    <option value="counselor">Admission Counselor</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                </div>
                <div>
                  <button 
                    type="submit" 
                    className="btn btn-primary"
                    disabled={creatingUser}
                    style={{ width: '100%', height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                  >
                    {creatingUser ? 'Creating...' : 'Create Account'}
                  </button>
                </div>
              </form>
            </div>

            {/* Team Roster Table */}
            <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: '2rem' }}>
              <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h5 style={{ margin: 0, fontSize: '0.95rem', color: '#1e293b', fontWeight: 700 }}>Staff Directory Roster</h5>
                <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>Showing {teamUsers.length} staff accounts</span>
              </div>
              <div className="table-container" style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Staff Member</th>
                      <th>Email / Identity</th>
                      <th>Username</th>
                      <th>Role</th>
                      <th>Account Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamUsers.length === 0 ? (
                      <tr>
                        <td colSpan="6" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
                          <p style={{ fontWeight: 600, color: 'var(--color-text-muted)', margin: 0 }}>No team users found.</p>
                        </td>
                      </tr>
                    ) : (
                      teamUsers.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: u.role === 'super_admin' ? '#fef3c7' : '#dbeafe', color: u.role === 'super_admin' ? '#b45309' : '#1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.85rem' }}>
                                {u.full_name ? u.full_name[0].toUpperCase() : 'U'}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, color: 'var(--color-text-main)' }}>{u.full_name}</div>
                                {u.id === currentUser?.id && <span style={{ fontSize: '0.68rem', color: '#2563eb', fontWeight: 700 }}>(You)</span>}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontSize: '0.82rem', color: '#334155' }}>{u.email}</span>
                          </td>
                          <td>
                            <code style={{ fontSize: '0.8rem', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>{u.username}</code>
                          </td>
                          <td>
                            <span style={{ 
                              padding: '0.2rem 0.6rem', 
                              borderRadius: '9999px', 
                              fontSize: '0.72rem', 
                              fontWeight: 700, 
                              textTransform: 'uppercase',
                              background: u.role === 'super_admin' ? '#fef3c7' : '#e0f2fe',
                              color: u.role === 'super_admin' ? '#92400e' : '#0369a1'
                            }}>
                              {u.role === 'super_admin' ? '👑 Super Admin' : '💬 Counselor'}
                            </span>
                          </td>
                          <td>
                            <span style={{ 
                              padding: '0.2rem 0.6rem', 
                              borderRadius: '9999px', 
                              fontSize: '0.72rem', 
                              fontWeight: 700,
                              background: u.is_active ? '#dcfce7' : '#fee2e2',
                              color: u.is_active ? '#15803d' : '#b91c1c'
                            }}>
                              {u.is_active ? '● Active' : '○ Disabled'}
                            </span>
                          </td>
                          <td className="text-right">
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                              {u.id !== currentUser?.id && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleUserStatus(u.id)}
                                    className="btn btn-secondary btn-xs"
                                    style={{ fontSize: '0.72rem' }}
                                  >
                                    {u.is_active ? 'Disable' : 'Activate'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteUser(u.id)}
                                    className="btn btn-danger btn-xs"
                                    style={{ fontSize: '0.72rem' }}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: activeView === 'reminders' ? 'block' : 'none', height: '100%', width: '100%' }}>
          {/* Reminders Dashboard grid */}
          <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: 'var(--radius-lg)' }}>
            <h4 style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>📞</span> Active Callback & Scheduled Time Slots
            </h4>

            {reminders.length === 0 ? (
              <div className="empty-container" style={{ padding: '3.5rem 0' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📅</div>
                <h5 className="empty-title">All Caught Up!</h5>
                <p className="empty-desc">No active call callbacks or scheduled time slots found from parents.</p>
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Candidate Details</th>
                      <th>Phone Numbers</th>
                      <th>Branch & Stage</th>
                      <th>Call Request & Initiator</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reminders.map((rem) => {
                      const initials = (rem.student_name || 'ST').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
                      const parentDisplay = (rem.parent_name && rem.parent_name !== 'N/A' && rem.parent_name !== 'None' && rem.parent_name !== 'Unknown Parent')
                        ? rem.parent_name
                        : (rem.parent_phone_number ? `Phone: ${rem.parent_phone_number}` : 'Not Provided');
                      
                      const rawCallText = rem.scheduled_call || rem.variables?.scheduled_call || rem.parent_response || 'Counselor Callback Requested';
                      const isParentRequested = rawCallText.includes('[Parent]') || rem.variables?.call_requested_by === 'Parent';
                      const cleanCallText = rawCallText.replace(/\[(Parent|Student)\]\s*/g, '');

                      return (
                        <tr key={rem.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <div className="avatar-circle" style={{ width: '36px', height: '36px', fontSize: '0.85rem' }}>{initials}</div>
                              <div>
                                <div style={{ fontWeight: '600', color: 'var(--text-main)' }}>{rem.student_name}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>👨‍👩‍👦 Parent: {parentDisplay}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                              <div><span style={{ fontWeight: '600' }}>Student:</span> {rem.phone_number}</div>
                              {rem.parent_phone_number && (
                                <div style={{ color: 'var(--text-muted)' }}><span style={{ fontWeight: '600' }}>Parent:</span> {rem.parent_phone_number}</div>
                              )}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-start' }}>
                              <span className="badge badge-tag-contacted" style={{ fontSize: '0.75rem' }}>
                                🎓 {rem.selected_branch || 'General'}
                              </span>
                              <span className="badge" style={{ fontSize: '0.7rem', backgroundColor: '#e0f2fe', color: '#0369a1', border: '1px solid #bae6fd' }}>
                                {rem.counselor_status === 'completed' ? '🟢 Resolved' : (rem.parent_response || 'Pending')}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                              <span className="badge" style={{ 
                                fontSize: '0.75rem', 
                                padding: '0.2rem 0.5rem', 
                                backgroundColor: isParentRequested ? '#fef3c7' : '#e0e7ff', 
                                color: isParentRequested ? '#92400e' : '#3730a3', 
                                border: isParentRequested ? '1px solid #fcd34d' : '1px solid #a5b4fc',
                                borderRadius: '4px',
                                fontWeight: '700',
                                width: 'fit-content'
                              }}>
                                {isParentRequested ? '👨‍👩‍👦 Parent Requested Call' : '🎓 Student Requested Call'}
                              </span>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-main)', fontWeight: '500' }}>
                                📞 {cleanCallText}
                              </span>
                            </div>
                          </td>
                          <td>
                            <button
                              className="btn btn-primary btn-sm"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.85rem' }}
                              onClick={() => {
                                setActiveChatRecordId(rem.id);
                                fetchChatHistory(rem.id);
                                fetchChatNotes(rem.id);
                                setActiveChatSubTab('chat');
                                setMobileActiveSubView('thread');
                                setActiveView('chat');
                                setSelectedChatTemplate('');
                                setForceFreeForm(false);
                              }}
                            >
                              💬 Open Chat
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: activeView === 'contacts' ? 'block' : 'none', height: '100%', width: '100%' }}>
          <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: 'var(--radius-lg)' }}>
            {/* Header Area */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>👥</span> Contacts Directory
              </h4>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => setIsImportContactsModalOpen(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <span>📥</span> Import Excel/CSV
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={() => {
                    setNewStudentName('');
                    setNewParentName('');
                    setNewPhoneNumber('');
                    setNewBranch('');
                    setNewPipelineTag('Lead');
                    setIsAddContactModalOpen(true);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <span>➕</span> Add Contact
                </button>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem', 
              marginBottom: '1.25rem', 
              flexWrap: 'wrap',
              backgroundColor: 'rgba(255, 255, 255, 0.4)',
              padding: '0.75rem 1.25rem',
              borderRadius: '12px',
              border: '1px solid var(--color-grey-border)'
            }}>
              <div className="search-container" style={{ width: '320px', margin: 0 }}>
                <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input 
                  type="text" 
                  placeholder="Search contacts..." 
                  value={contactsSearch}
                  onChange={(e) => setContactsSearch(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Branch:</span>
                <select 
                  className="filter-select"
                  value={contactsBranch}
                  onChange={(e) => { setContactsBranch(e.target.value); setContactsPage(1); }}
                  style={{ height: '38px', padding: '0.5rem 2rem 0.5rem 1rem' }}
                >
                  <option value="all">All Branches</option>
                  {branches.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>

                {/* View Mode Toggle Switch */}
                <div style={{ display: 'flex', gap: '4px', background: '#e2e8f0', padding: '2px', borderRadius: '6px', marginLeft: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => { setContactsViewMode('list'); setContactsPage(1); }}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: contactsViewMode === 'list' ? '#ffffff' : 'transparent',
                      color: contactsViewMode === 'list' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: contactsViewMode === 'list' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    🗂️ List
                  </button>
                  <button
                    type="button"
                    onClick={() => { setContactsViewMode('kanban'); setContactsPage(1); }}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      background: contactsViewMode === 'kanban' ? '#ffffff' : 'transparent',
                      color: contactsViewMode === 'kanban' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                      boxShadow: contactsViewMode === 'kanban' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                    }}
                  >
                    📋 Kanban Board
                  </button>
                </div>
              </div>
            </div>

            {/* Contacts Table vs Kanban View rendering */}
            {contactsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4rem 0', gap: '1rem' }}>
                <div className="loader-spinner" style={{ borderTopColor: 'var(--color-blue)' }}></div>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading contacts...</span>
              </div>
            ) : contactsList.length === 0 ? (
              <div className="empty-container" style={{ padding: '3.5rem 0' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>👥</div>
                <h5 className="empty-title">No Contacts Found</h5>
                <p className="empty-desc">Try clearing filters or search queries, or add new contacts manually.</p>
              </div>
            ) : contactsViewMode === 'kanban' ? (
              <div className="kanban-board-container">
                {[
                  { title: 'New Leads', tag: 'Lead', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)' },
                  { title: 'Contacted', tag: 'Contacted', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
                  { title: 'Interested', tag: 'Interested', color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
                  { title: 'Enrolled', tag: 'Enrolled', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)' },
                  { title: 'Not Interested', tag: 'Not Interested', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)' }
                ].map(column => {
                  const columnContacts = contactsList.filter(c => (c.pipeline_tag || 'Lead') === column.tag);
                  return (
                    <div 
                      key={column.tag} 
                      className={`kanban-column ${dragOverColumn === column.tag ? 'drag-over' : ''}`}
                      onDragOver={(e) => handleDragOver(e, column.tag)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, column.tag)}
                      style={{ borderTop: `4px solid ${column.color}` }}
                    >
                      <div className="kanban-column-header">
                        <div className="kanban-column-title">
                          <span style={{ color: column.color }}>●</span>
                          {column.title}
                        </div>
                        <span className="kanban-column-count">{columnContacts.length}</span>
                      </div>
                      <div className="kanban-cards-wrapper">
                        {columnContacts.map(contact => {
                          const initials = contact.student_name ? contact.student_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : 'N/A';
                          return (
                            <div
                              key={contact.id}
                              className="kanban-card"
                              draggable
                              onDragStart={(e) => handleDragStart(e, contact.id)}
                            >
                              <div className="kanban-card-title-row">
                                <div className="kanban-card-avatar" style={{ backgroundColor: column.bg, color: column.color }}>{initials}</div>
                                <span className="kanban-card-name">{contact.student_name}</span>
                              </div>
                                <div className="kanban-card-details">
                                  {contact.parent_name && contact.parent_name !== 'N/A' && contact.parent_name !== 'None' && contact.parent_name !== 'Unknown Parent' ? (
                                    <div className="kanban-card-detail-item">
                                      <span style={{ opacity: 0.6 }}>👪 Parent:</span> {contact.parent_name}
                                    </div>
                                  ) : (
                                    <div className="kanban-card-detail-item">
                                      <span style={{ opacity: 0.45, fontStyle: 'italic' }}>👪 Parent: Not Provided</span>
                                    </div>
                                  )}
                                  <div className="kanban-card-detail-item">
                                    <span style={{ opacity: 0.6 }}>📱 Student:</span> +{contact.phone_number}
                                  </div>
                                  {contact.parent_phone_number && (
                                    <div className="kanban-card-detail-item">
                                      <span style={{ opacity: 0.6 }}>📱 Parent:</span> +{contact.parent_phone_number}
                                    </div>
                                  )}
                                  <div className="kanban-card-detail-item" style={{ marginTop: '0.2rem' }}>
                                    <span className="badge" style={{ fontSize: '0.7rem', backgroundColor: 'var(--color-blue-light)', color: 'var(--color-blue)', border: '1px solid var(--color-blue-border)', padding: '0.1rem 0.4rem' }}>
                                      {contact.selected_branch}
                                    </span>
                                  </div>
                                </div>
                              <div className="kanban-card-actions">
                                <button
                                  className="btn btn-secondary btn-sm"
                                  style={{ flex: 1, padding: '0.25rem', fontSize: '0.75rem', justifyContent: 'center' }}
                                  onClick={() => {
                                    setActiveChatRecordId(contact.id);
                                    fetchChatHistory(contact.id);
                                    fetchChatNotes(contact.id);
                                    setActiveChatSubTab('chat');
                                    setMobileActiveSubView('thread');
                                    setActiveView('chat');
                                    setSelectedChatTemplate('');
                                    setForceFreeForm(false);
                                  }}
                                >
                                  💬 Chat
                                </button>
                                <button
                                  className="btn btn-primary btn-sm"
                                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                  onClick={() => {
                                    setContactToEdit(contact);
                                    setEditStudentName(contact.student_name);
                                    setEditParentName(contact.parent_name);
                                    setEditPhoneNumber(contact.phone_number);
                                    setEditParentPhoneNumber(contact.parent_phone_number || '');
                                    setEditBranch(contact.selected_branch);
                                    setEditPipelineTag(contact.pipeline_tag || 'Lead');
                                    setIsEditContactModalOpen(true);
                                  }}
                                >
                                  ✏️
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {columnContacts.length === 0 && (
                          <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', minHeight: '120px', border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                            Drag candidates here
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Student Name</th>
                        <th>Parent Name</th>
                        <th>Student Phone</th>
                        <th>Parent Phone</th>
                        <th>Branch</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactsList.map((contact) => {
                        const initials = contact.student_name ? contact.student_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : 'N/A';

                        return (
                          <tr key={contact.id}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <div className="avatar-circle" style={{ width: '32px', height: '32px', fontSize: '0.75rem' }}>{initials}</div>
                                <span className="cell-title" style={{ fontWeight: '600' }}>{contact.student_name}</span>
                              </div>
                            </td>
                            <td>
                              {contact.parent_name && contact.parent_name !== 'N/A' && contact.parent_name !== 'None' && contact.parent_name !== 'Unknown Parent' ? (
                                <span>{contact.parent_name}</span>
                              ) : (
                                <span style={{ opacity: 0.45, fontStyle: 'italic' }}>Not Provided</span>
                              )}
                            </td>
                            <td style={{ fontWeight: '500' }}>📱 +{contact.phone_number}</td>
                            <td style={{ fontWeight: '500' }}>
                              {contact.parent_phone_number ? (
                                <span>📱 +{contact.parent_phone_number}</span>
                              ) : (
                                <span style={{ opacity: 0.45, fontStyle: 'italic' }}>N/A</span>
                              )}
                            </td>
                            <td>
                              <span className="badge badge-tag-contacted" style={{ fontSize: '0.75rem', backgroundColor: 'var(--color-blue-light)', color: 'var(--color-blue)', border: '1px solid var(--color-blue-border)' }}>
                                {contact.selected_branch}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '0.4rem' }}>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => {
                                    setActiveChatRecordId(contact.id);
                                    fetchChatHistory(contact.id);
                                    fetchChatNotes(contact.id);
                                    setActiveChatSubTab('chat');
                                    setMobileActiveSubView('thread');
                                    setActiveView('chat');
                                    setSelectedChatTemplate('');
                                    setForceFreeForm(false);
                                  }}
                                  title="Open Chat"
                                >
                                  💬 Chat
                                </button>
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => {
                                    setContactToEdit(contact);
                                    setEditStudentName(contact.student_name || '');
                                    setEditParentName(contact.parent_name || '');
                                    setEditPhoneNumber(contact.phone_number || '');
                                    setEditParentPhoneNumber(contact.parent_phone_number || '');
                                    setEditBranch(contact.selected_branch || '');
                                    setEditPipelineTag(contact.pipeline_tag || 'Lead');
                                    setIsEditContactModalOpen(true);
                                  }}
                                  title="Edit Contact"
                                >
                                  ✏️ Edit
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={() => handleDeleteContact(contact.id)}
                                  title="Delete Contact"
                                >
                                  🗑️ Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Showing <strong>{contactsList.length}</strong> of <strong>{contactsTotal}</strong> contacts
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={contactsPage === 1}
                      onClick={() => fetchContacts(contactsPage - 1)}
                    >
                      Previous
                    </button>
                    <span style={{ display: 'flex', alignItems: 'center', padding: '0 0.75rem', fontSize: '0.875rem', fontWeight: '500' }}>
                      Page {contactsPage} of {Math.ceil(contactsTotal / contactsLimit) || 1}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={contactsPage >= Math.ceil(contactsTotal / contactsLimit)}
                      onClick={() => fetchContacts(contactsPage + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

      </main>


      {/* 4. Global notifications toaster container */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type} show`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                {toast.type === 'success' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                )}
                {toast.type === 'error' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                )}
                {toast.type === 'info' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                )}
              </span>
              <span className="toast-content">{toast.message}</span>
            </div>
            <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
          </div>
        ))}
      </div>

      {/* 5. Custom Premium Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
              <div className="confirm-modal-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div style={{ flexGrow: 1 }}>
                <h4 style={{
                  margin: 0,
                  fontSize: '1.125rem',
                  fontWeight: '600',
                  color: 'var(--text-primary)',
                  lineHeight: '1.5'
                }}>{confirmModal.title}</h4>
                <p style={{
                  margin: '0.5rem 0 0 0',
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                  lineHeight: '1.5'
                }}>{confirmModal.message}</p>
              </div>
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.75rem',
              marginTop: '0.5rem'
            }}>
              <button
                onClick={closeConfirmModal}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="btn btn-primary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      {isChangePasswordOpen && (
        <div className="confirm-modal-overlay">
          <form onSubmit={handleChangePassword} className="confirm-modal-card" style={{ maxWidth: '400px', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1rem' }}>
              <div className="confirm-modal-icon" style={{ background: 'rgba(124, 77, 255, 0.1)', color: 'var(--color-purple)' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </div>
              <div style={{ flexGrow: 1 }}>
                <h4 style={{ margin: 0, fontSize: '1.125rem', fontWeight: '600', color: 'var(--text-primary)' }}>Change Password</h4>
                <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>Update the system administrator account password.</p>
              </div>
            </div>
            
            {changePasswordError && (
              <div style={{
                background: 'rgba(239, 83, 80, 0.1)',
                border: '1px solid rgba(239, 83, 80, 0.2)',
                color: '#ef5350',
                padding: '0.75rem',
                borderRadius: '8px',
                fontSize: '0.8125rem',
                marginBottom: '1rem'
              }}>
                {changePasswordError}
              </div>
            )}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <label style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>Current Password</label>
                <input
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: '8px',
                    border: '1px solid var(--color-grey-border)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--text-primary)',
                    fontSize: '0.875rem'
                  }}
                  required
                />
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <label style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: '8px',
                    border: '1px solid var(--color-grey-border)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--text-primary)',
                    fontSize: '0.875rem'
                  }}
                  required
                />
              </div>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                onClick={() => setIsChangePasswordOpen(false)}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
                disabled={changePasswordLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
                disabled={changePasswordLoading}
              >
                {changePasswordLoading ? 'Saving...' : 'Update Password'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Contact Modal */}
      {isAddContactModalOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card" style={{ maxWidth: '500px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-grey-border)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>➕</span> Add New Contact
              </h4>
              <button 
                onClick={() => setIsAddContactModalOpen(false)} 
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleAddContact} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Student Name *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={newStudentName}
                  onChange={(e) => setNewStudentName(e.target.value)}
                  placeholder="e.g. John Doe"
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Parent Name *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={newParentName}
                  onChange={(e) => setNewParentName(e.target.value)}
                  placeholder="e.g. Richard Doe"
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Student Phone Number *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={newPhoneNumber}
                  onChange={(e) => setNewPhoneNumber(e.target.value)}
                  placeholder="e.g. 919381758768"
                  required
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Include country code (e.g. 91 for India) without symbols or spaces.</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Parent Phone Number</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={newParentPhoneNumber}
                  onChange={(e) => setNewParentPhoneNumber(e.target.value)}
                  placeholder="e.g. 919876543210"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Include country code (e.g. 91 for India) without symbols or spaces.</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Academic Branch *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="e.g. CSE, ECE, EEE, MECH"
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setIsAddContactModalOpen(false)}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                >
                  Save Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Contact Modal */}
      {isEditContactModalOpen && contactToEdit && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card" style={{ maxWidth: '500px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-grey-border)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>✏️</span> Edit Contact Details
              </h4>
              <button 
                onClick={() => setIsEditContactModalOpen(false)} 
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleEditContact} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Student Name *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={editStudentName}
                  onChange={(e) => setEditStudentName(e.target.value)}
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Parent Name *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={editParentName}
                  onChange={(e) => setEditParentName(e.target.value)}
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Student Phone Number *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={editPhoneNumber}
                  onChange={(e) => setEditPhoneNumber(e.target.value)}
                  required
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Include country code (e.g. 91 for India) without symbols or spaces.</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Parent Phone Number</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={editParentPhoneNumber}
                  onChange={(e) => setEditParentPhoneNumber(e.target.value)}
                  placeholder="e.g. 919876543210"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Include country code (e.g. 91 for India) without symbols or spaces.</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-primary)' }}>Academic Branch *</label>
                <input 
                  type="text" 
                  className="search-input" 
                  value={editBranch}
                  onChange={(e) => setEditBranch(e.target.value)}
                  placeholder="e.g. CSE, ECE, EEE, MECH"
                  required
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setIsEditContactModalOpen(false)}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                >
                  Update Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Contacts Modal */}
      {isImportContactsModalOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card" style={{ maxWidth: '500px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-grey-border)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
              <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>📥</span> Bulk Import Contacts
              </h4>
              <button 
                onClick={() => setIsImportContactsModalOpen(false)} 
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                &times;
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
                Upload an Excel (.xlsx) or CSV (.csv) file to import multiple contacts. The file should have columns matching: 
                <strong> Student Name</strong>, <strong>Parent Name</strong>, <strong>Student Phone Number</strong>, <strong>Parent Phone Number</strong>, and <strong>Branch</strong>.
              </p>

              <div style={{
                border: '2px dashed var(--color-blue-border)',
                borderRadius: '8px',
                padding: '2rem 1.5rem',
                textAlign: 'center',
                backgroundColor: 'var(--color-blue-light)',
                cursor: 'pointer',
                position: 'relative'
              }}>
                <input 
                  type="file" 
                  accept=".xlsx,.csv" 
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      handleImportContacts(e.target.files[0]);
                    }
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    opacity: 0,
                    cursor: 'pointer',
                    width: '100%',
                    height: '100%'
                  }}
                />
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📊</div>
                <span style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--color-blue)' }}>Click or Drag Spreadsheet to Upload</span>
                <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Supports .xlsx and .csv files</span>
              </div>

              {importing && (
                <div style={{ 
                  backgroundColor: 'rgba(255,255,255,0.8)',
                  padding: '1rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-blue-border)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.35rem' }}>
                    <span style={{ color: 'var(--text-primary)' }}>{importStatusText}</span>
                    <span style={{ color: 'var(--color-blue)' }}>{importProgress}%</span>
                  </div>
                  <div style={{ height: '6px', width: '100%', backgroundColor: 'var(--color-grey-border)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${importProgress}%`, backgroundColor: 'var(--color-blue)', transition: 'width 0.1s ease-out' }}></div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  disabled={importing}
                  onClick={() => setIsImportContactsModalOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
